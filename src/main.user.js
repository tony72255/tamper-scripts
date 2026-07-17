// ==UserScript==
// @name         Lotte Mart - v15.6.5 (Fixed RLS + Response)
// @namespace    https://grok.x.ai
// @version      15.6.5
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

    function logger(level, msg, data = '') {
        console.log(`[Lotem v15.6.5 ${level}] ${msg}`, data);
    }

    function supabaseRequest(method, path, body = null, extraHeaders = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
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

    async function getPendingJobs() {
        try {
            const res = await supabaseRequest("GET", `/jobs?status=eq.pending&order=created_at.desc&limit=20`);
            const jobs = JSON.parse(res.responseText || "[]");
            logger('INFO', `Tìm thấy ${jobs.length} job pending`);

            for (const job of jobs) {
                if (!processedJobIds.has(job.id)) {
                    await claimJobAtomic(job);
                }
            }
        } catch (e) {
            logger('ERROR', 'getPendingJobs lỗi', e);
        }
    }

    async function claimJobAtomic(job) {
        try {
            // Dùng return=representation để lấy kết quả
            const res = await supabaseRequest(
                "PATCH",
                `/jobs?id=eq.${job.id}&status=eq.pending`,
                {
                    status: "processing",
                    claimed_at: new Date().toISOString(),
                    worker_secret: WORKER_SECRET
                },
                { "Prefer": "return=representation" }   // ← quan trọng
            );

            let updated = [];
            try {
                updated = JSON.parse(res.responseText || "[]");
            } catch (_) {}

            if (updated.length > 0) {
                processedJobIds.set(job.id, Date.now());
                logger('SUCCESS', `✅ Claim thành công: ${job.srcmk_cd}`);
                // Sau này sẽ gọi process job ở đây
            } else {
                logger('WARN', `Không update được job ${job.id} (RLS chặn hoặc job đã bị claim)`);
            }
        } catch (e) {
            logger('ERROR', `Lỗi claim job ${job.id}`, e);
        }
    }

    async function start() {
        logger('INFO', 'Worker khởi động');
        await getPendingJobs();
        setInterval(getPendingJobs, 4000);
    }

    start();
})();
