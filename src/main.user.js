// ==UserScript==
// @name         Lotte Mart - Supabase Realtime (v15.7 Stable)
// @namespace    https://grok.x.ai
// @version      15.7
// @description  Stable version - Early claim + Fast poll 2s
// @author       Lotem
//@updateURL    https://raw.githubusercontent.com/tony72255/tamper-scripts/main/src/main.user.js
//@downloadURL  https://raw.githubusercontent.com/tony72255/tamper-scripts/main/src/main.user.js
// @match        https://gmd.lottemart.vn/*
// @match        https://m.lottemart.vn/*
// @grant        GM_xmlhttpRequest
// @connect      xdnawsvcbjqxwvufrkxb.supabase.co
// @require      https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.3/dist/umd/supabase.min.js
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';


    // ==================== CONFIG ====================
    const SUPABASE_URL = "https://xdnawsvcbjqxwvufrkxb.supabase.co";
    const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhkbmF3c3ZjYmpxeHd2dWZya3hiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxMTQ0NTgsImV4cCI6MjA5OTY5MDQ1OH0.TC46lk0CXuo0sp_X8KgbDAnnSkzRSRkl1XXuBixl3zY";
    const WORKER_SECRET = "lotte-mart-worker-2026";
    const SUPABASE_REST = `${SUPABASE_URL}/rest/v1`;

    const JOB_DELAY = 300;
    const MAX_CONCURRENT = 2;
    const FALLBACK_POLL_INTERVAL = 2000;           // 2 giây (nhanh)
    const LOG_LEVEL = 'info';
    const PROCESSED_MAX_AGE_MS = 2 * 60 * 60 * 1000;

    const KEEP_ALIVE_INTERVAL = 12 * 60 * 1000;
    const CACHE_TTL_MS = 60 * 1000;
    const REQUEST_TIMEOUT_MS = 25000;

    let jobQueue = [];
    let activeJobs = 0;
    let processedJobIds = new Map();
    let supabaseClient = null;
    let resultCache = new Map();

    function logger(level, ...args) {
        const levels = { debug: 0, info: 1, warn: 2, error: 3 };
        if ((levels[level] || 0) >= (levels[LOG_LEVEL] || 1)) {
            const prefix = `[Lotem v15 ${level.toUpperCase()}]`;
            if (level === 'error') console.error(prefix, ...args);
            else if (level === 'warn') console.warn(prefix, ...args);
            else console.log(prefix, ...args);
        }
    }

    function initSupabase() {
        if (typeof supabase !== 'undefined' && supabase.createClient) {
            supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        }
    }

    function supabaseRequest(method, path, body = null, extraHeaders = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: method,
                url: `${SUPABASE_REST}${path}`,
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "apikey": SUPABASE_ANON_KEY,
                    "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
                    ...extraHeaders
                },
                data: body ? JSON.stringify(body) : undefined,
                onload: resolve,
                onerror: reject
            });
        });
    }

    async function updateWorkerStatus() {
        try {
            const now = Date.now();
            await supabaseRequest("POST", `/worker_status`, {
                id: "lotte_worker",
                last_seen: now,
                status: "online",
                updated_at: new Date().toISOString(),
                worker_secret: WORKER_SECRET
            }, { "Prefer": "resolution=merge-duplicates" });
        } catch (e) {}
    }

    async function getPendingJobs() {
        try {
            const res = await supabaseRequest("GET", `/jobs?status=eq.pending&order=created_at.desc&limit=50`);
            const jobs = JSON.parse(res.responseText || "[]");
            jobs.forEach(row => {
                if (!processedJobIds.has(row.id)) {
                    processedJobIds.set(row.id, Date.now()); // Claim sớm
                    addJobToQueue({
                        job_id: row.id,
                        str_cd: row.str_cd || "",
                        srcmk_cd: row.srcmk_cd || "",
                        batch_id: row.batch_id || "",
                        chat_id: row.chat_id || null
                    });
                }
            });
        } catch (e) {}
    }

    async function updateJobToSupabase(jobId, data) {
        try {
            await supabaseRequest("PATCH", `/jobs?id=eq.${jobId}`, {
                ...data,
                worker_secret: WORKER_SECRET
            });
        } catch (e) {}
    }
    async function claimJobAtomic(jobId) {
    if (!jobId) {
        logger('error', 'claimJobAtomic gọi với jobId rỗng/undefined');
        return false;
    }
    try {
        const res = await supabaseRequest(
            "PATCH",
            `/jobs?id=eq.${jobId}&status=eq.pending`,
            {
                status: "processing",
                worker_secret: WORKER_SECRET
            },
            { "Prefer": "return=representation" }
        );

        const updated = JSON.parse(res.responseText || "[]");
        return updated.length > 0;
    } catch (e) {
        logger('error', 'claimJobAtomic failed', e);
        return false;
    }
}
    async function deleteJob(jobId) {
        try {
            await supabaseRequest("DELETE", `/jobs?id=eq.${jobId}`);
        } catch (e) {}
    }

    function getCachedResult(strCd, srcmkCd) {
        const key = `${strCd}:${srcmkCd}`;
        const cached = resultCache.get(key);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
            return cached.data;
        }
        return null;
    }

    function setCacheResult(strCd, srcmkCd, data) {
        const key = `${strCd}:${srcmkCd}`;
        resultCache.set(key, { data, timestamp: Date.now() });
        if (resultCache.size > 150) {
            const firstKey = resultCache.keys().next().value;
            resultCache.delete(firstKey);
        }
    }

    function subscribeToPendingJobs() {
        if (!supabaseClient) return;

        supabaseClient
            .channel('pending-jobs-v15')
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'jobs',
                filter: 'status=eq.pending'
            }, (payload) => {
                const job = payload.new;
                if (job && job.id && !processedJobIds.has(job.id)) {
                    processedJobIds.set(job.id, Date.now()); // Claim sớm
                    addJobToQueue({
                        job_id: row.id,
                        str_cd: row.str_cd || "",
                        srcmk_cd: row.srcmk_cd || "",
                        batch_id: row.batch_id || "",
                        chat_id: row.chat_id || null
                    });
                }
            })
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    logger('info', 'Realtime connected');
                }
            });
    }

    function padStrCd(strCd) { return String(strCd).padStart(5, "0"); }

    function buildProductSearchSSV(strCd, srcmkCd) {
        const trackingParts = [
            "_ga=GA1.1.1926722522.1779273587",
            "_tt_enable_cookie=1",
            "_ttp=01KS2FGQ5DSMV0QST60J6GQ9NR_.tt.1",
            "_fbp=fb.1.1779273589322.638506231644770626",
            "_gcl_au=1.1.521987338.1779273587.2028705533.1779275328.1779275328",
            "KHANUSER=z4rrvm1e3ie7hj",
            "ttcsid=1781444122718::1bply3lfNEMONUk-wYjJ.5.1781444136006.0::1.-3701.0::0.0.0.0::0.0.0",
            "ttcsid_D34HLIRC77U5SFKT9RAG=1781444122717::Ys34mY0t4l3zL3CvLbae.5.1781444136009.1",
            "_ga_6QLJ7DM4XW=GS2.1.s1781443507$o6$g1$t1781444233$j60$l0$h0"
        ];

        const tracking = trackingParts.join("\u001e");

        const business =
            "natCd=VNM\u001elanguage=ENG\u001ecorpFg=01\u001emenuId=M06555\u001epage=false" +
            "\u001eDataset:search" +
            "\u001e_RowType_\u001fstr_cd:STRING(256)\u001fsrcmk_cd:STRING(256)\u001fprod_cd:STRING(256)" +
            "\u001eN\u001f" + strCd + "\u001f" + srcmkCd + "\u001f\u0003" +
            "\u001eN\u001f\u0003\u001f\u0003\u001f\u0003" +
            "\u001eN\u001f\u0003\u001f\u0003\u001f\u0003";

        return "SSV:utf-8\u001e" + tracking + "\u001e" + business + "\u001e\u001e";
    }

    function parseProductResponse(ssvText) {
        if (!ssvText || ssvText.includes("ErrorCode:int=-1")) {
            return { success: false, data: [] };
        }
        const parts = ssvText.split("\u001e");
        const result = [];
        let columns = [];
        parts.forEach(part => {
            if (part.startsWith("_RowType_")) {
                columns = part.replace("_RowType_\u001f", "").split("\u001f").map(c => c.split(":")[0]);
            } else if (part.startsWith("N\u001f")) {
                const values = part.split("\u001f");
                if (values.length > 1 && columns.length > 0) {
                    const row = {};
                    columns.forEach((col, i) => row[col] = values[i + 1] || "");
                    result.push(row);
                }
            }
        });
        return { success: true, data: result };
    }

    function fetchProductData(strCd, srcmkCd) {
        return new Promise(resolve => {
            const cached = getCachedResult(strCd, srcmkCd);
            if (cached) {
                logger('debug', `Cache hit: ${strCd}-${srcmkCd}`);
                return resolve(cached);
            }

            let requestTimedOut = false;

            const timeoutId = setTimeout(() => {
                requestTimedOut = true;
                logger('warn', `Request timeout → Auto reload`);
                location.reload();
                resolve({ success: false, data: [], timedOut: true });
            }, REQUEST_TIMEOUT_MS);

            GM_xmlhttpRequest({
                method: "POST",
                url: "https://m.lottemart.vn/ivm/ivm71/ivm71002/selectDiscardRegList.do",
                headers: {
                    "Content-Type": "text/xml; charset=utf-8",
                    "Accept": "application/xml, text/xml, */*"
                },
                data: buildProductSearchSSV(padStrCd(strCd), srcmkCd),
                onload: res => {
                    clearTimeout(timeoutId);
                    if (requestTimedOut) return;

                    const parsed = parseProductResponse(res.responseText);
                    if (parsed.success && parsed.data.length > 0) {
                        setCacheResult(strCd, srcmkCd, parsed);
                    }
                    resolve(parsed);
                },
                onerror: () => {
                    clearTimeout(timeoutId);
                    if (requestTimedOut) return;

                    logger('warn', 'Network error → Auto reload');
                    location.reload();
                    resolve({ success: false, data: [], timedOut: true });
                }
            });
        });
    }

    async function processNextJob() {
    if (activeJobs >= MAX_CONCURRENT || jobQueue.length === 0) return;

    const job = jobQueue.shift();

    // === BẢO VỆ: Kiểm tra job hợp lệ ===
    if (!job || !job.job_id) {
        logger('warn', 'Invalid job object in queue (thiếu job_id), skip', job);
        setTimeout(processNextJob, JOB_DELAY);
        return;
    }

    // === ATOMIC CLAIM ===
    const claimed = await claimJobAtomic(job.job_id);
    if (!claimed) {
        logger('warn', `Job ${job.job_id} đã bị worker khác claim`);
        processedJobIds.set(job.job_id, Date.now());
        setTimeout(processNextJob, JOB_DELAY);
        return;
    }

    processedJobIds.set(job.job_id, Date.now());
    activeJobs++;

    const result = await fetchProductData(job.str_cd, job.srcmk_cd);

    const summaryText = (!result.success || result.data.length === 0)
        ? `❌ Không tìm thấy dữ liệu cho Kho: <code>${job.str_cd}</code> | Mã: <code>${job.srcmk_cd}</code>`
        : formatResultText(job.str_cd, job.srcmk_cd, result.data);

    await updateJobToSupabase(job.job_id, {
        status: "done",
        batch_id: job.batch_id,
        chat_id: job.chat_id,
        result: { summary_text: summaryText, raw_data: result.data || [] },
        processed_at: new Date().toISOString()
    });

    setTimeout(() => deleteJob(job.job_id), 10 * 60 * 1000);

    activeJobs--;
    setTimeout(processNextJob, JOB_DELAY);
}

    function addJobToQueue(job) {
    if (!job || !job.job_id) {
        logger('warn', 'addJobToQueue bị gọi với job không hợp lệ, bỏ qua', job, new Error().stack);
        return;
    }
    jobQueue.push(job);
    processNextJob();
    processNextJob();
}

    function formatResultText(strCd, srcmkCd, data) {
        if (!data || data.length === 0) {
            return `❌ Không tìm thấy sản phẩm cho Kho: <code>${strCd}</code> | Mã: <code>${srcmkCd}</code>`;
        }
        let text = `✅ <b>Kết quả tra cứu</b>\nKho: <code>${strCd}</code> | Mã: <code>${srcmkCd}</code>\n\n`;
        data.forEach((item, i) => {
            text += `<b>${i+1}. ${item.prod_nm || "Không có tên"}</b>\n• Tồn kho khả dụng: <code>${item.avail_jego_qty || 0}</code>\n• Giá mua: <code>${item.buy_prc || 0}</code>\n• Giá bán: <code>${item.sale_prc || 0}</code>\n\n`;
        });
        return text;
    }

    function keepSessionAlive() {
        logger('info', '🔄 Keep-alive: Reload trang');
        location.reload();
    }

    function cleanupProcessedJobs() {
        const now = Date.now();
        for (const [id, ts] of processedJobIds) {
            if (now - ts > PROCESSED_MAX_AGE_MS) {
                processedJobIds.delete(id);
            }
        }
    }

    async function start() {
        const isMainPage = location.href.includes("gmd/index.html") || location.href.includes("m.lottemart.vn/gmd");
        if (!isMainPage) return;

        initSupabase();
        if (supabaseClient) subscribeToPendingJobs();

        await updateWorkerStatus();
        getPendingJobs();

        setInterval(getPendingJobs, FALLBACK_POLL_INTERVAL);
        setInterval(updateWorkerStatus, 45000);
        setInterval(keepSessionAlive, KEEP_ALIVE_INTERVAL);
        setInterval(cleanupProcessedJobs, 15 * 60 * 1000);

        logger('info', 'Lotem v15.2 Stable started');
    }

    start();
})();
