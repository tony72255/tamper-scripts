// ==UserScript==
// @name         [TEST] Telegram Control - Lotte Mart
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Điều khiển bật/tắt script bằng Telegram Bot + Firebase (chỉ trang GMD)
// @author       You
// @match        https://m.lottemart.vn/gmd/index.html
// @grant        GM_xmlhttpRequest
// @connect      quoc-anh-34159-default-rtdb.asia-southeast1.firebasedatabase.app
// ==/UserScript==

(function () {
    'use strict';

    // ============ CẤU HÌNH ============
    const FIREBASE_URL = "https://quoc-anh-34159-default-rtdb.asia-southeast1.firebasedatabase.app/control/scripts_enabled.json";
    const CHECK_INTERVAL = 1500; // 1.5 giây
    // ==================================

    let isEnabled = null;

    // Hàm log đẹp lên console
    function logStatus(message, isEnabledState) {
        const time = new Date().toLocaleTimeString("vi-VN");
        const style = isEnabledState
            ? "color: #16a34a; font-weight: bold; font-size: 13px;"
            : "color: #dc2626; font-weight: bold; font-size: 13px;";

        console.log(`%c[${time}] ${message}`, style);
    }

    // Kiểm tra trạng thái từ Firebase
    function checkStatus() {
        GM_xmlhttpRequest({
            method: "GET",
            url: FIREBASE_URL + "?t=" + Date.now(),
            onload: function (res) {
                try {
                    const newStatus = res.responseText.trim() === "true";

                    if (newStatus !== isEnabled) {
                        const oldStatus = isEnabled;
                        isEnabled = newStatus;

                        if (oldStatus === null) {
                            logStatus(`Khởi tạo trạng thái: ${isEnabled ? "BẬT" : "TẮT"}`, isEnabled);
                        } else {
                            logStatus(`ĐÃ NHẬN LỆNH TỪ TELEGRAM → ${isEnabled ? "BẬT SCRIPTS" : "TẮT SCRIPTS"}`, isEnabled);
                        }
                    }
                } catch (e) {
                    console.error("[Control] Lỗi parse dữ liệu Firebase:", e);
                }
            },
            onerror: function (err) {
                console.error("[Control] Không kết nối được Firebase:", err);
            }
        });
    }

    // ============ LOGIC CHÍNH (chỉ chạy khi BẬT) ============
    function mainLogic() {
        if (!isEnabled) return;

        // Sau này viết code thật vào đây
        console.log("%c[MAIN] Logic chính đang chạy...", "color: #2563eb; font-weight: bold");
    }

    // ============ KHỞI ĐỘNG ============
    function init() {
        checkStatus();
        setInterval(checkStatus, CHECK_INTERVAL);
        setInterval(mainLogic, 5000);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
