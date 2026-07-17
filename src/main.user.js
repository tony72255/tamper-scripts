// ==UserScript==
// @name         Lotte Mart - DEBUG v15.6.4 (Verbose Claim)
// @namespace    https://grok.x.ai
// @version      15.6.4
// @match        https://gmd.lottemart.vn/*
// @match        https://m.lottemart.vn/*
// @grant        GM_xmlhttpRequest
// @connect      xdnawsvcbjqxwvufrkxb.supabase.co
// @require      https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.3/dist/umd/supabase.min.js
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const SUPABASE_URL = "https://xdnawsvcbjqxwvufrkxb.supabase.co";
    const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhkbmF3c3ZjYmpxeHd2dWZya3hiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxMTQ0NTgsImV4cCI6MjA5OTY5MDQ1OH0.TC46lk0CXuo0sp_X8KgbDAnnSkzRSRkl1XXuBixl3zY";
    const WORKER_SECRET = "lotte-mart-worker-2026";
    const SUPABASE_REST = `${SUPABASE_URL}/rest/v1`;

    let processedJobIds = new Map();

    function logger(level, ...args) {
        const prefix = `[Lotem DEBUG ${level.toUpperCase()}]`;
        if (level === 'error') console.error(prefix, ...args);
        else console.log(prefix, ...args);
    }

    function supabaseRequest(method, path, body = null) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url: `${SUPABASE_REST}${path}`,
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "apikey": SUPABASE_ANON_KEY,
                    "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
                },
                data: body ? JSON.stringify(body) : undefined,
                onload: resolve,
                onerror: reject
            });
        });
    }

    async function getPendingJobs() {
        logger('info', 'Đang query jobs pending...');
        try {
            const res = await supabaseRequest("GET", `/jobs?status=eq.pending&order=created_at.desc&limit=20`);
            const jobs = JSON.parse(res.responseText || "[]");
            
            logger('info', `Tìm thấy ${jobs.length} job pending`);

            if (jobs.length === 0) {
                logger('warn', 'Không có job pending nào lúc này');
                return;
            }

            for (const job of jobs) {
                logger('info', `Đang thử claim job: ${job.id} | srcmk: ${job.srcmk_cd} | status: ${job.status}`);
                await claimJobAtomic(job);
            }
        } catch (e) {
            logger('error', 'Lỗi getPendingJobs:', e);
        }
    }

    async function claimJobAtomic(rawJob) {
        const jobId = rawJob.id;
        if (!jobId) return;

        if (processedJobIds.has(jobId)) {
            logger('warn', `Job ${jobId} đã được xử lý trước đó (local)`);
            return;
        }

        try {
            const res = await supabaseRequest("PATCH", 
                `/jobs?id=eq.${jobId}&status=eq.pending`, 
                {
                    status: "processing",
                    claimed_at: new Date().toISOString(),
                    worker_secret: WORKER_SECRET
                }
            );

            const updated = JSON.parse(res.responseText || "[]");
            logger('info', `PATCH response: ${updated.length} row(s) updated`);

            if (updated.length > 0) {
                processedJobIds.set(jobId, Date.now());
                logger('info', `✅ ĐÃ CLAIM THÀNH CÔNG job ${jobId}`);
                // Sau này sẽ thêm processNextJob ở đây
            } else {
                logger('warn', `Không claim được job ${jobId} (có thể do RLS hoặc job không còn pending)`);
            }
        } catch (e) {
            logger('error', `Lỗi khi claim job ${jobId}:`, e);
        }
    }

    async function start() {
        logger('info', 'Script bắt đầu chạy');

        // Chạy ngay 1 lần
        await getPendingJobs();

        // Sau đó poll mỗi 5 giây
        setInterval(getPendingJobs, 5000);

        logger('info', 'Đã khởi động polling');
    }

    start();
})();
