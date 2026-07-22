import os
import logging
import time
import threading
from datetime import datetime, timedelta, timezone
from telebot import TeleBot, types
from telebot.apihelper import ApiTelegramException
from supabase import create_client, Client
from dotenv import load_dotenv
from logging.handlers import RotatingFileHandler
from collections import defaultdict
# ==================== FIREBASE ====================
import firebase_admin
from firebase_admin import credentials, db

# Load biến môi trường từ file .env
load_dotenv()

# ==================== CẤU HÌNH ====================
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
BOT_TOKEN = os.getenv("BOT_TOKEN")
WORKER_SECRET = os.getenv("WORKER_SECRET")
ADMIN_CHAT_ID = int(os.getenv("ADMIN_CHAT_ID"))
# === Photo collecting (chống race khi gửi ảnh nhanh) ===
photo_buffers = {} #defaultdict(list)      # chat_id → list barcode
photo_timers = {}                      # chat_id → Timer
photo_lock = threading.Lock()
PHOTO_COLLECT_SECONDS = 1.8            # thời gian gom ảnh

# Kiểm tra bắt buộc
if not all([SUPABASE_URL, SUPABASE_SERVICE_KEY, BOT_TOKEN, WORKER_SECRET, ADMIN_CHAT_ID]):
    raise ValueError("❌ Thiếu thông tin cấu hình trong file .env")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# ==================== FIREBASE INIT ====================
FIREBASE_DB_URL = "https://quoc-anh-34159-default-rtdb.asia-southeast1.firebasedatabase.app"

if not firebase_admin._apps:
    # Đặt file serviceAccountKey.json cùng thư mục với ga.py
    cred = credentials.Certificate("serviceAccountKey.json")
    firebase_admin.initialize_app(cred, {
        'databaseURL': FIREBASE_DB_URL
    })

def get_scripts_enabled() -> bool:
    try:
        value = db.reference("control/scripts_enabled").get()
        return bool(value)
    except Exception as e:
        logger.error(f"Lỗi đọc scripts_enabled: {e}")
        return False

def set_scripts_enabled(enabled: bool) -> bool:
    try:
        db.reference("control/scripts_enabled").set(enabled)
        return True
    except Exception as e:
        logger.error(f"Lỗi ghi scripts_enabled: {e}")
        return False

# ==================== LOGGING ====================
log_formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')

file_handler = RotatingFileHandler(
    "lotte_bot.log",
    maxBytes=50 * 1024 * 1024,
    backupCount=7,
    encoding="utf-8"
)
file_handler.setFormatter(log_formatter)

console_handler = logging.StreamHandler()
console_handler.setFormatter(log_formatter)

logging.basicConfig(
    level=logging.WARNING,
    handlers=[file_handler, console_handler]
)

logger = logging.getLogger(__name__)

# ==================== BOT INIT ====================
bot = TeleBot(BOT_TOKEN, parse_mode="HTML")

user_states = {}
batch_results = {}
processed_job_ids = set()

# ==================== MENU ====================
def get_main_menu():
    markup = types.InlineKeyboardMarkup(row_width=1)
    markup.add(
        types.InlineKeyboardButton("🔍 Tra cứu sản phẩm", callback_data="search_product"),
        types.InlineKeyboardButton("📅 Tra ngày hàng về", callback_data="delivery_schedule"),  # MỚI
        #types.InlineKeyboardButton("📦 Dự kiến hàng về", callback_data="expected_delivery"),   # MỚI (làm sau)
        types.InlineKeyboardButton("📆 Tính % hạn sử dụng", callback_data="calc_shelf_life"),
        types.InlineKeyboardButton("📖 Hướng dẫn sử dụng", callback_data="help")
    )
    return markup

# ==================== WORKER STATUS ====================
worker_status_cache = {
    "last_check": 0,
    "is_alive": True,
    "status_text": "📡 Trạng thái Direct API: ✅ Đang hoạt động"
}

def get_worker_status_text():
    global worker_status_cache
    current_time = time.time()

    # Cache 8 giây để tránh query liên tục
    if current_time - worker_status_cache["last_check"] < 8:
        return worker_status_cache["status_text"]

    try:
        res = supabase.table("worker_heartbeat") \
            .select("last_seen, status, note") \
            .eq("id", "main") \
            .single() \
            .execute()

        if not res.data:
            status = "📡 Trạng thái Direct API: ❌ Không tìm thấy heartbeat"
        else:
            last_seen_str = res.data.get("last_seen")
            status_db = res.data.get("status", "unknown")

            # Parse thời gian
            last_seen = datetime.fromisoformat(last_seen_str.replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            seconds_ago = int((now - last_seen).total_seconds())

            if seconds_ago <= 90:  # còn sống nếu < 90 giây
                status = f"📡 Trạng thái Direct API: ✅ Đang hoạt động ({seconds_ago}s trước)"
            else:
                status = f"📡 Trạng thái Direct API: ❌ Mất kết nối ({seconds_ago}s trước)"

    except Exception as e:
        logger.error(f"Lỗi đọc worker heartbeat: {e}")
        status = "📡 Trạng thái Direct API: ⚠️ Không đọc được trạng thái"

    worker_status_cache["last_check"] = current_time
    worker_status_cache["status_text"] = status
    return status

def show_main_menu(chat_id):
    status_text = get_worker_status_text()
    text = (
        "🤖 <b>Lotte Mart - Tra cứu Tồn kho</b>\n"
        "Phiên bản v15.0 • Direct API Worker\n\n"
        f"{status_text}\n\n"
        "Vui lòng chọn chức năng:"
    )
    bot.send_message(chat_id, text, reply_markup=get_main_menu())

@bot.message_handler(commands=['start', 'menu'])
def cmd_start(message):
    show_main_menu(message.chat.id)

@bot.message_handler(commands=['status', 'worker'])
def cmd_worker_status(message):
    status = get_worker_status_text()
    bot.send_message(message.chat.id, status)

# ==================== ĐIỀU KHIỂN SCRIPTS (CHỈ ADMIN) ====================
@bot.message_handler(commands=['control', 'scripts'])
def cmd_control(message):
    if message.chat.id != ADMIN_CHAT_ID:
        bot.reply_to(message, "⛔ Bạn không có quyền sử dụng lệnh này.")
        return

    current = get_scripts_enabled()
    status = "🟢 ĐANG BẬT" if current else "🔴 ĐANG TẮT"

    markup = types.InlineKeyboardMarkup()
    markup.row(
        types.InlineKeyboardButton("🟢 BẬT SCRIPTS", callback_data="scripts_on"),
        types.InlineKeyboardButton("🔴 TẮT SCRIPTS", callback_data="scripts_off")
    )

    bot.send_message(
        message.chat.id,
        f"⚙️ <b>Điều khiển Tampermonkey Scripts</b>\n\n"
        f"Trạng thái hiện tại: <b>{status}</b>",
        reply_markup=markup
    )

@bot.callback_query_handler(func=lambda call: True)
def callback_handler(call):
    chat_id = call.message.chat.id
    data = call.data
    
    # ========== XỬ LÝ BẬT/TẮT SCRIPTS ==========
    if data in ("scripts_on", "scripts_off"):
        if chat_id != ADMIN_CHAT_ID:
            bot.answer_callback_query(call.id, "⛔ Bạn không có quyền!", show_alert=True)
            return

        enabled = (data == "scripts_on")
        success = set_scripts_enabled(enabled)

        if success:
            status = "🟢 ĐÃ BẬT" if enabled else "🔴 ĐÃ TẮT"
            markup = types.InlineKeyboardMarkup()
            markup.row(
                types.InlineKeyboardButton("🟢 BẬT SCRIPTS", callback_data="scripts_on"),
                types.InlineKeyboardButton("🔴 TẮT SCRIPTS", callback_data="scripts_off")
            )
            try:
                bot.edit_message_text(
                    chat_id=chat_id,
                    message_id=call.message.message_id,
                    text=f"⚙️ <b>Điều khiển Tampermonkey Scripts</b>\n\n"
                         f"Trạng thái: <b>{status}</b>",
                    reply_markup=markup
                )
            except Exception:
                pass
            bot.answer_callback_query(call.id, status)
        else:
            bot.answer_callback_query(call.id, "❌ Lỗi cập nhật Firebase", show_alert=True)
        return

    # ========== LOGIC CŨ GIỮ NGUYÊN ==========
    if data == "search_product":
        markup = types.InlineKeyboardMarkup(row_width=1)
        markup.add(
            types.InlineKeyboardButton("🏪 Nha Trang (01013)", callback_data="store_01013"),
            types.InlineKeyboardButton("🏪 GOLD COAST (01015)", callback_data="store_01015")
        )
        bot.send_message(
            chat_id,
            "📦 <b>Tra cứu sản phẩm</b>\n\nVui lòng chọn kho:",
            reply_markup=markup
        )
        bot.answer_callback_query(call.id)

    elif data == "store_01013":
        # Reset state để user có thể chọn kho mới bất cứ lúc nào (fix issue 2)
        user_states[chat_id] = {"step": "srcmk_cd", "str_cd": "01013"}
        bot.send_message(
            chat_id,
            "✅ Đã chọn kho <b>Nha Trang</b> (<code>01013</code>)\n\n"
            "Gửi <b>ảnh chứa mã vạch</b> hoặc nhập barcode bằng tay (cách nhau dấu phẩy <code>,</code>):"
        )
        bot.answer_callback_query(call.id)

    elif data == "store_01015":
        # Reset state để user có thể chọn kho mới bất cứ lúc nào (fix issue 2)
        user_states[chat_id] = {"step": "srcmk_cd", "str_cd": "01015"}
        bot.send_message(
            chat_id,
            "✅ Đã chọn kho <b>GOLD COAST</b> (<code>01015</code>)\n\n"
            "Gửi <b>ảnh chứa mã vạch</b> hoặc nhập barcode bằng tay (cách nhau dấu phẩy <code>,</code>):"
        )
        bot.answer_callback_query(call.id)

    elif data == "calc_shelf_life":
        markup = types.InlineKeyboardMarkup(row_width=1)
        markup.add(
            types.InlineKeyboardButton("📆 Ngày SX + Hạn SD (DD/MM/YYYY)", callback_data="shelf_method_expiry"),
            types.InlineKeyboardButton("📆 Ngày SX + Số ngày hạn SD (ví dụ: 180)", callback_data="shelf_method_days")
        )
        bot.send_message(
            chat_id,
            "📅 <b>Tính % hạn sử dụng</b>\n\n"
            "Chọn phương thức tính toán thông minh:\n\n"
            "• <b>Ngày SX + Hạn SD</b>: Nhập ngày sản xuất và hạn sử dụng cụ thể\n"
            "• <b>Ngày SX + Số ngày</b>: Dành cho sản phẩm chỉ có ngày SX + hạn ngày (thông minh tự tính hạn SD)",
            reply_markup=markup
        )
        bot.answer_callback_query(call.id)

    elif data == "shelf_method_expiry":
        user_states[chat_id] = {"step": "shelf_production", "method": "expiry"}
        bot.send_message(chat_id, "📅 <b>Phương thức: Ngày SX + Hạn SD</b>\n\nVui lòng nhập <b>Ngày sản xuất</b> (định dạng <code>DD/MM/YYYY</code>):")
        bot.answer_callback_query(call.id)

    elif data == "shelf_method_days":
        user_states[chat_id] = {"step": "shelf_production", "method": "days"}
        bot.send_message(chat_id, "📅 <b>Phương thức: Ngày SX + Số ngày hạn SD</b> (thông minh)\n\nVui lòng nhập <b>Ngày sản xuất</b> (định dạng <code>DD/MM/YYYY</code>):")
        bot.answer_callback_query(call.id)

    elif data == "help":
        help_text = (
            "📖 <b>Hướng dẫn sử dụng v15.0</b>\n\n"
            "1. Nhấn <b>🔍 Tra cứu sản phẩm</b>\n"
            "2. Chọn kho (Nha Trang hoặc GOLD COAST)\n"
            "3. Nhập mã sản phẩm (<code>barcode</code>), cách nhau dấu phẩy\n"
            "4. Kết quả được gửi trực tiếp từ <b>Direct API Worker</b>\n\n"
            "⚠️ Direct API Worker phải đang hoạt động (xem /status)"
        )
        bot.send_message(chat_id, help_text)
        bot.answer_callback_query(call.id)

    elif data == "delivery_schedule":
        markup = types.InlineKeyboardMarkup(row_width=1)
        markup.add(
            types.InlineKeyboardButton("🏪 Nha Trang (01013)", callback_data="deli_store_01013"),
            types.InlineKeyboardButton("🏪 GOLD COAST (01015)", callback_data="deli_store_01015")
        )
        bot.send_message(chat_id, "📅 <b>Tra ngày hàng về</b>\n\nVui lòng chọn kho:", reply_markup=markup)
        bot.answer_callback_query(call.id)

    elif data in ("deli_store_01013", "deli_store_01015"):
        str_cd = data.split("_")[-1]
        # Reset state để user có thể chọn kho mới bất cứ lúc nào (fix issue 2)
        # Đồng thời đơn giản hóa flow: chỉ còn 1 bước nhập khoảng ngày (fix issue 1)
        user_states[chat_id] = {"step": "deli_date_custom", "str_cd": str_cd}
        
        bot.send_message(
            chat_id,
            "📅 <b>Tra ngày hàng về</b>\n\n"
            f"✅ Đã chọn kho <code>{str_cd}</code>\n\n"
            "Vui lòng nhập <b>khoảng ngày</b> theo định dạng:\n"
            "<code>01/07/2026 - 21/07/2026</code>\n\n"
            "• Từ ngày - Đến ngày (cách nhau dấu gạch ngang)"
        )
        bot.answer_callback_query(call.id)

    elif data.startswith("deli_range_"):
        state = user_states.get(chat_id, {})
        days = data.split("_")[-1]

        if days == "custom":
            state["step"] = "deli_date_custom"
            user_states[chat_id] = state
            bot.send_message(chat_id, "Nhập khoảng ngày theo định dạng:\n<code>01/07/2026 - 21/07/2026</code>")
        else:
            from datetime import datetime, timedelta
            today = datetime.now().date()
            to_dt = today + timedelta(days=int(days))
            state["from_dt"] = today.strftime("%Y%m%d")
            state["to_dt"] = to_dt.strftime("%Y%m%d")
            state["step"] = "deli_barcode"
            user_states[chat_id] = state
            bot.send_message(chat_id, "Gửi <b>barcode</b> hoặc ảnh mã vạch:")
        
            bot.answer_callback_query(call.id)

    elif data == "expected_delivery":
            markup = types.InlineKeyboardMarkup(row_width=1)
            markup.add(
                types.InlineKeyboardButton("🏪 Nha Trang (01013)", callback_data="exp_store_01013"),
                types.InlineKeyboardButton("🏪 GOLD COAST (01015)", callback_data="exp_store_01015")
            )
            bot.send_message(chat_id, "📦 <b>Dự kiến hàng về</b>\n\nVui lòng chọn kho:", reply_markup=markup)
            bot.answer_callback_query(call.id)

    elif data in ("exp_store_01013", "exp_store_01015"):
        str_cd = data.split("_")[-1]
        user_states[chat_id] = {"step": "exp_date", "str_cd": str_cd, "job_type": "expected_delivery"}
        
        markup = types.InlineKeyboardMarkup(row_width=1)
        markup.add(
            types.InlineKeyboardButton("7 ngày tới", callback_data="exp_range_7"),
            types.InlineKeyboardButton("14 ngày tới", callback_data="exp_range_14"),
            types.InlineKeyboardButton("30 ngày tới", callback_data="exp_range_30"),
            types.InlineKeyboardButton("✏️ Tự nhập khoảng ngày", callback_data="exp_range_custom")
        )
        bot.send_message(chat_id, "Chọn khoảng ngày cần xem dự kiến:", reply_markup=markup)
        bot.answer_callback_query(call.id)

@bot.message_handler(func=lambda message: message.chat.id in user_states)
def handle_user_input(message):
    chat_id = message.chat.id
    state = user_states.get(chat_id)
    if not state:
        return

    text = (message.text or "").strip()

    # ========== LOGIC CŨ: tra cứu sản phẩm ==========
    if state.get("step") == "srcmk_cd":
        srcmk_list = [x.strip() for x in text.replace("\n", ",").split(",") if x.strip()]
        str_cd = state["str_cd"]
        process_product_search(chat_id, str_cd, srcmk_list, message.from_user)
        if chat_id in user_states:
            del user_states[chat_id]
        return

    # ========== LOGIC CŨ: tính hạn sử dụng ==========
    if state.get("step") == "shelf_production":
        state["production_date"] = text
        method = state.get("method", "expiry")
        if method == "days":
            state["step"] = "shelf_days"
            bot.send_message(chat_id, "✅ Đã nhận ngày sản xuất.\n\nVui lòng nhập <b>Số ngày hạn sử dụng</b> (ví dụ: <code>180</code>):")
        else:
            state["step"] = "shelf_expiry"
            bot.send_message(chat_id, "✅ Đã nhận ngày sản xuất.\n\nVui lòng nhập <b>Hạn sử dụng</b> (định dạng <code>DD/MM/YYYY</code>):")
        return

    if state.get("step") == "shelf_expiry":
        production_date = state.get("production_date")
        expiry_date = text
        result_text, error = calculate_shelf_life(production_date, expiry_date)
        if error:
            bot.send_message(chat_id, error)
        else:
            bot.send_message(chat_id, result_text)
        if chat_id in user_states:
            del user_states[chat_id]
        return

    if state.get("step") == "shelf_days":
        production_date = state.get("production_date")
        try:
            days = int(text.strip())
            if days <= 0:
                raise ValueError("Số ngày phải lớn hơn 0")
            prod = None
            for fmt in ("%d/%m/%Y", "%d-%m/%Y", "%Y-%m-%d", "%d.%m/%Y"):
                try:
                    prod = datetime.strptime(production_date.strip(), fmt).date()
                    break
                except ValueError:
                    continue
            if not prod:
                bot.send_message(chat_id, "❌ Định dạng ngày sản xuất không hợp lệ.")
                return
            exp = prod + timedelta(days=days)
            exp_str = exp.strftime("%d/%m/%Y")
            result_text, error = calculate_shelf_life(production_date, exp_str)
            if error:
                bot.send_message(chat_id, error)
            else:
                note = f"\n\n📌 <i>Đã tính hạn sử dụng tự động: {exp_str} (từ ngày SX + {days} ngày)</i>"
                bot.send_message(chat_id, result_text + note)
        except ValueError as ve:
            bot.send_message(chat_id, f"❌ Số ngày không hợp lệ: {str(ve)}")
        except Exception as e:
            bot.send_message(chat_id, f"❌ Có lỗi xảy ra: {str(e)}")
        if chat_id in user_states:
            del user_states[chat_id]
        return

    # ========== PHẦN MỚI: Tra ngày hàng về ==========
    if state.get("step") == "deli_date_custom":
        try:
            from datetime import datetime as dt
            clean = text.strip().replace(" ", "").replace("–", "-").replace("—", "-")
            parts = clean.split("-")
            if len(parts) != 2:
                raise ValueError("Sai định dạng")

            from_dt = dt.strptime(parts[0], "%d/%m/%Y").strftime("%Y%m%d")
            to_dt = dt.strptime(parts[1], "%d/%m/%Y").strftime("%Y%m%d")

            state["from_dt"] = from_dt
            state["to_dt"] = to_dt
            state["step"] = "deli_barcode"
            user_states[chat_id] = state

            bot.send_message(chat_id, "Gửi <b>barcode</b> hoặc ảnh mã vạch:")
        except Exception as e:
            logger.error(f"Parse date error: {e} | input: {text}")
            bot.send_message(chat_id, "❌ Định dạng sai. Vui lòng nhập:\n<code>01/07/2026 - 21/07/2026</code>")
        return

    if state.get("step") == "deli_barcode":
        srcmk_list = [x.strip() for x in text.replace("\n", ",").split(",") if x.strip()]
        if not srcmk_list:
            bot.send_message(chat_id, "❌ Không có barcode hợp lệ.")
            return

        total = len(srcmk_list)
        batch_id = f"deli_{int(time.time() * 1000)}_{chat_id}"

        batch_results[batch_id] = {
            "chat_id": chat_id,
            "str_cd": state["str_cd"],
            "total": total,
            "results": [],
            "loading_msg_id": None,
            "completed": 0
        }

        try:
            loading_msg = bot.send_message(
                chat_id,
                f"⏳ Đang tra cứu <b>{total}</b> barcode (ngày hàng về)..."
            )
            batch_results[batch_id]["loading_msg_id"] = loading_msg.message_id
        except Exception as e:
            logger.error(f"Send loading error: {e}")

        for srcmk_cd in srcmk_list:
            create_delivery_job(
                str_cd=state["str_cd"],
                srcmk_cd=srcmk_cd,
                from_dt=state["from_dt"],
                to_dt=state["to_dt"],
                quay=state.get("quay"),
                chat_id=chat_id,
                batch_id=batch_id
            )

        if chat_id in user_states:
            del user_states[chat_id]
        return

def create_delivery_job(str_cd, srcmk_cd, from_dt, to_dt, quay, chat_id, batch_id):
    job_id = f"deli_{int(time.time() * 1000)}_{chat_id}_{srcmk_cd}"
    job_data = {
        "id": job_id,
        "job_type": "delivery_schedule",
        "str_cd": str_cd,
        "srcmk_cd": srcmk_cd,
        "from_dt": from_dt,
        "to_dt": to_dt,
        "quay": quay,
        "batch_id": batch_id,
        "chat_id": chat_id,
        "status": "pending",
        "result": None,
        "worker_secret": WORKER_SECRET
    }
    try:
        supabase.table("jobs").insert(job_data).execute()
        logger.info(f"Created delivery job {job_id}")
    except Exception as e:
        logger.error(f"create_delivery_job error: {e}")

@bot.message_handler(content_types=['photo'])
def handle_barcode_photo(message):
    chat_id = message.chat.id
    state = user_states.get(chat_id)

    if not state or state.get("step") != "srcmk_cd":
        bot.reply_to(message, "Vui lòng chọn kho trước khi gửi ảnh mã vạch.")
        return

    str_cd = state["str_cd"]

    try:
        file_id = message.photo[-1].file_id
        file_info = bot.get_file(file_id)
        image_bytes = bot.download_file(file_info.file_path)

        barcodes = decode_barcodes_from_image(image_bytes)

        with photo_lock:
            if chat_id not in photo_buffers:
                photo_buffers[chat_id] = {
                    "barcodes": [],
                    "total_photos": 0,
                    "success_photos": 0
                }

            buffer = photo_buffers[chat_id]
            buffer["total_photos"] += 1

            if barcodes:
                buffer["barcodes"].extend(barcodes)
                buffer["success_photos"] += 1

            if chat_id in photo_timers:
                photo_timers[chat_id].cancel()

            def process_collected():
                with photo_lock:
                    data = photo_buffers.pop(chat_id, None)
                    if chat_id in photo_timers:
                        del photo_timers[chat_id]

                if not data:
                    return

                unique_barcodes = list(dict.fromkeys(data["barcodes"]))
                total_photos = data["total_photos"]
                success_photos = data["success_photos"]
                failed_photos = total_photos - success_photos

                if unique_barcodes:
                    process_product_search(chat_id, str_cd, unique_barcodes, message.from_user)

                    summary = (
                        f"📸 <b>Đã xử lý ảnh</b>\n"
                        f"• Nhận diện thành công: <b>{success_photos}</b> ảnh\n"
                        f"• Không nhận diện được: <b>{failed_photos}</b> ảnh (hình không rõ)"
                    )
                    bot.send_message(chat_id, summary)
                else:
                    bot.send_message(
                        chat_id,
                        f"❌ Đã nhận {total_photos} ảnh nhưng không nhận diện được mã vạch nào.\n"
                        f"Hãy chụp gần hơn, rõ nét và đủ sáng rồi thử lại."
                    )

            timer = threading.Timer(PHOTO_COLLECT_SECONDS, process_collected)
            timer.daemon = True
            timer.start()
            photo_timers[chat_id] = timer

            if buffer["total_photos"] == 1:
                bot.reply_to(message, "📸 Đang nhận và xử lý ảnh mã vạch...")

    except Exception as e:
        logger.error(f"Lỗi xử lý ảnh barcode: {e}")

def decode_barcodes_from_image(image_bytes: bytes) -> list[str]:
    try:
        import cv2
        import numpy as np
        import zxingcpp

        nparr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return []

        h, w = img.shape[:2]
        max_side = max(h, w)
        if max_side > 1280:
            scale = 1280 / max_side
            img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        results = set()

        def try_decode(image):
            try:
                barcodes = zxingcpp.read_barcodes(image)
                for bc in barcodes:
                    data = bc.text.strip()
                    if data.isdigit() and len(data) in (8, 12, 13, 14):
                        results.add(data)
            except Exception:
                pass

        try_decode(gray)
        if results:
            return list(results)

        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
        try_decode(clahe.apply(gray))
        if results:
            return list(results)

        try_decode(cv2.bitwise_not(gray))
        if results:
            return list(results)

        try_decode(cv2.rotate(gray, cv2.ROTATE_180))
        if results:
            return list(results)

        try_decode(cv2.bitwise_not(clahe.apply(gray)))
        return list(results)

    except Exception as e:
        logger.error(f"Lỗi decode barcode (zxing-cpp): {e}")
        return []

def process_product_search(chat_id: int, str_cd: str, srcmk_list: list[str], from_user):
    if not srcmk_list:
        bot.send_message(chat_id, "❌ Không có mã sản phẩm hợp lệ.")
        return

    total = len(srcmk_list)
    batch_id = f"batch_{int(time.time() * 1000)}_{chat_id}"

    batch_results[batch_id] = {
        "chat_id": chat_id,
        "str_cd": str_cd,
        "total": total,
        "results": [],
        "loading_msg_id": None,
        "completed": 0
    }

    try:
        full_name = f"{from_user.first_name or ''} {from_user.last_name or ''}".strip() or "Không có tên"
        username = f"@{from_user.username}" if from_user.username else "Không có username"
        vn_time = datetime.now(timezone(timedelta(hours=7)))

        admin_log = (
            f"🔔 <b>Có người đang tra cứu</b>\n\n"
            f"👤 <b>Tên:</b> {full_name}\n"
            f"🔗 <b>Username:</b> {username}\n"
            f"🆔 <b>User ID:</b> <code>{from_user.id}</code>\n"
            f"💬 <b>Chat ID:</b> <code>{chat_id}</code>\n"
            f"📦 <b>Kho:</b> <code>{str_cd}</code>\n"
            f"🔢 <b>Số mã:</b> {total}\n"
            f"⏰ <b>Thời gian:</b> {vn_time.strftime('%d/%m/%Y %H:%M:%S')}"
        )
        bot.send_message(ADMIN_CHAT_ID, admin_log)
    except Exception as e:
        logger.error(f"Gửi log admin thất bại: {e}")

    try:
        loading_msg_id = send_simple_loading(chat_id, total)
        batch_results[batch_id]["loading_msg_id"] = loading_msg_id
    except Exception as e:
        logger.error(f"Failed to send loading message: {e}")
        return

    for srcmk_cd in srcmk_list:
        create_job(str_cd, srcmk_cd, batch_id, chat_id)

def create_job(str_cd, srcmk_cd, batch_id, chat_id):
    job_id = f"{int(time.time() * 1000)}_{chat_id}_{srcmk_cd}"
    job_data = {
        "id": job_id,
        "str_cd": str_cd,
        "srcmk_cd": srcmk_cd,
        "batch_id": batch_id,
        "chat_id": chat_id,
        "status": "pending",
        "result": None,
        "worker_secret": WORKER_SECRET
    }
    try:
        supabase.table("jobs").insert(job_data).execute()
        logger.info(f"Created job {job_id} for {str_cd}|{srcmk_cd}")
    except Exception as e:
        logger.error(f"create_job error: {e}")
    return job_id

def send_simple_loading(chat_id, total):
    try:
        msg = bot.send_message(
            chat_id,
            f"⏳ Đang tra cứu <b>{total}</b> mã sản phẩm...\nPhiên bản v15.0 • Direct API"
        )
        return msg.message_id
    except Exception as e:
        logger.error(f"Send loading message error: {e}")
        return None

# ==================== RESULT DELIVERY POLLER ====================
def poll_and_deliver_results():
    while True:
        try:
            res = (supabase.table("jobs")
                   .select("id, chat_id, result, batch_id, str_cd, srcmk_cd")
                   .eq("status", "done")
                   .limit(50)
                   .execute())

            for job in res.data:
                job_id = job["id"]
                if job_id in processed_job_ids:
                    continue

                chat_id = job.get("chat_id")
                result = job.get("result") or {}
                summary_text = result.get("summary_text", "")
                batch_id = job.get("batch_id")
                srcmk_cd = job.get("srcmk_cd")

                try:
                    claim = supabase.table("jobs").update({"status": "delivering"}) \
                        .eq("id", job_id).eq("status", "done").execute()
                    if not claim.data:
                        processed_job_ids.add(job_id)
                        continue
                except Exception as e:
                    logger.warning(f"Claim failed {job_id}: {e}")
                    continue

                if batch_id and batch_id in batch_results:
                    br = batch_results[batch_id]
                    br["results"].append({
                        "srcmk_cd": srcmk_cd,
                        "summary_text": summary_text
                    })
                    br["completed"] += 1

                    try:
                        if br["completed"] < br["total"]:
                            progress = f"⏳ Đang tra cứu <b>{br['completed']}/{br['total']}</b> mã..."
                            bot.edit_message_text(chat_id=chat_id, 
                                                  message_id=br["loading_msg_id"], 
                                                  text=progress)
                        else:
                            final_text = f"✅ <b>Kết quả tra cứu kho <code>{br['str_cd']}</code></b>\n\n"
                            
                            for r in br["results"]:
                                final_text += r["summary_text"] + "\n"

                            bot.edit_message_text(chat_id=chat_id,
                                                  message_id=br["loading_msg_id"],
                                                  text=final_text)
                            
                            if batch_id in batch_results:
                                del batch_results[batch_id]
                    except Exception as e:
                        logger.error(f"Edit message error: {e}")

                processed_job_ids.add(job_id)

                try:
                    supabase.table("jobs").delete().eq("id", job_id).execute()
                except Exception as e:
                    logger.warning(f"Delete job failed {job_id}: {e}")

            if len(processed_job_ids) > 500:
                processed_job_ids.clear()

            time.sleep(2)

        except Exception as e:
            logger.error(f"[Poller] {e}")
            time.sleep(10)

# ==================== TÍNH % HẠN SỬ DỤNG ====================
def calculate_shelf_life(production_date: str, expiry_date: str):
    try:
        prod = None
        exp = None
        for fmt in ("%d/%m/%Y", "%d-%m/%Y", "%Y-%m-%d", "%d.%m/%Y"):
            try:
                prod = datetime.strptime(production_date.strip(), fmt).date()
                exp = datetime.strptime(expiry_date.strip(), fmt).date()
                break
            except ValueError:
                continue

        if not prod or not exp:
            return None, "❌ Định dạng ngày không hợp lệ. Vui lòng dùng dạng <code>DD/MM/YYYY</code>"

        if exp <= prod:
            return None, "❌ Hạn sử dụng phải sau ngày sản xuất."

        today = datetime.now().date()
        total_days = (exp - prod).days
        days_used = (today - prod).days
        days_remaining = (exp - today).days

        if days_used < 0:
            percent_used = 0
            status = "🟢 Sản phẩm chưa đến ngày sản xuất"
        elif days_remaining < 0:
            percent_used = 100
            status = "🔴 Sản phẩm đã quá hạn sử dụng"
        else:
            percent_used = round((days_used / total_days) * 100, 1)
            status = "🟡 Đang trong hạn sử dụng"

        percent_remaining = round(100 - percent_used, 1)

        result_text = (
            f"📅 <b>Kết quả tính hạn sử dụng</b>\n\n"
            f"• Ngày sản xuất: <code>{prod.strftime('%d/%m/%Y')}</code>\n"
            f"• Hạn sử dụng: <code>{exp.strftime('%d/%m/%Y')}</code>\n"
            f"• Tổng thời hạn: <b>{total_days}</b> ngày\n\n"
            f"• Đã sử dụng: <b>{max(days_used, 0)}</b> ngày ({percent_used}%)\n"
            f"• Còn lại: <b>{max(days_remaining, 0)}</b> ngày ({percent_remaining}%)\n\n"
            f"<b>{status}</b>"
        )
        return result_text, None
    except Exception as e:
        return None, f"❌ Có lỗi xảy ra: {str(e)}"

# ==================== RUN BOT ====================
def run_bot():
    logger.info("🚀 Lotte Mart Bot v15.0 + Direct API Worker đang khởi động...")

    poller_thread = threading.Thread(target=poll_and_deliver_results, daemon=True)
    poller_thread.start()

    while True:
        try:
            bot.infinity_polling(timeout=25, long_polling_timeout=25)
        except ApiTelegramException as e:
            logger.error(f"Telegram API error: {e}")
            if "bot was blocked" in str(e).lower() or "unauthorized" in str(e).lower():
                break
            time.sleep(10)
        except Exception as e:
            logger.error(f"Bot polling crashed: {e}")
            time.sleep(15)

if __name__ == "__main__":
    run_bot()