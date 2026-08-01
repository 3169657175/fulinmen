// ==UserScript==
// @name         爱零工审单数据助手福临门
// @namespace    http://tampermonkey.net/
// @version      1.4.1
// @description  统计每日及每小时审核订单量，支持日期切换。内置一键通过审核助手（Alt+A）及题目折叠功能（福临门专版）。
// @author       Antigravity
// @match        *://admin2.slicejobs.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/echarts/5.4.3/echarts.min.js
// @require      https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      productandservice.cofco.com
// @connect      sjimgpub.slicejobs.com
// @connect      *.slicejobs.com
// @connect      *.aliyuncs.com
// @run-at       document-start
// ==/UserScript==

(/* @global echarts */ function() {
    'use strict';

    // 后台预热 iframe 只负责让网站提前请求下一单数据和图片，不运行插件主体。
    const FLM_IS_WARM_FRAME = window.self !== window.top &&
        new URLSearchParams(location.search).get('flm_warm') === '1';

    // 判断是否为初审工单 (v3.6)
    // 接口字段 review 代表当前工单的审核轮次：0 表示初审；>=1 表示复审单。
    // 如果没有 review 字段，默认为初审。
    const isFirstRoundAudit = (item) => {
        if (item && item.review !== undefined && item.review !== null) {
            return parseInt(item.review, 10) === 0;
        }
        return true;
    };

    // 全局状态
    let currentDate = new Date();
    let chartInstance = null;
    let currentDayStats = null;    // 缓存当前加载日期的统计数据以供导出
    let currentWeeklyStats = null; // 缓存当前加载周期的统计数据以供导出
    let currentTab = 'daily';      // 当前标签页: 'daily' | 'weekly'
    let manuallyExpandedQuestions = new Set();
    let reviewLastLocationHref = null;
    let q22SelectedForCurrentOrder = false;
    let auditHelperVerifiedQ13Options = new Set();
    let resizeHandler = null;      // 全局共享的 resize 处理器，防内存泄漏
    const queryCache = {};         // 内存缓存 API 请求，防接口高频被限流
    let autoRefreshInterval = null; // 自动刷新定时器

    // 每日审核目标独立存储与管理 (v2.9)
    const getTargetForDate = (dateStr) => {
        try {
            const targetsJson = localStorage.getItem('sj_stats_targets_by_date');
            if (targetsJson) {
                const targetsMap = JSON.parse(targetsJson);
                if (targetsMap[dateStr]) {
                    const targetVal = parseInt(targetsMap[dateStr], 10);
                    if (!isNaN(targetVal) && targetVal > 0) {
                        return targetVal;
                    }
                }
            }
        } catch (e) {
            console.warn("Failed to read sj_stats_targets_by_date:", e);
        }
        // 回退默认目标
        return parseInt(localStorage.getItem('sj_stats_target') || '200', 10);
    };

    const setTargetForDate = (dateStr, targetVal) => {
        let targetsMap = {};
        try {
            const targetsJson = localStorage.getItem('sj_stats_targets_by_date');
            if (targetsJson) {
                targetsMap = JSON.parse(targetsJson);
            }
        } catch (e) {
            console.warn("Failed to parse targets map, resetting:", e);
        }

        targetsMap[dateStr] = targetVal;
        localStorage.setItem('sj_stats_targets_by_date', JSON.stringify(targetsMap));
        // 也同步更新全局默认目标，以便作为未来日期的新默认值
        localStorage.setItem('sj_stats_target', targetVal);
    };

    // 每日最高审核量观测记录与管理 (v3.4 遗留，用于向下兼容 v3.5 的历史退单数据)
    const getMaxObservedForDate = (dateStr) => {
        try {
            const dataJson = localStorage.getItem('sj_stats_max_observed_counts');
            if (dataJson) {
                const map = JSON.parse(dataJson);
                if (map && typeof map === 'object' && map[dateStr]) {
                    const val = parseInt(map[dateStr], 10);
                    if (!isNaN(val) && val > 0) {
                        return val;
                    }
                }
            }
        } catch (e) {
            console.warn("Failed to read sj_stats_max_observed_counts:", e);
        }
        return 0;
    };

    const setMaxObservedForDate = (dateStr, count) => {
        try {
            let map = {};
            const dataJson = localStorage.getItem('sj_stats_max_observed_counts');
            if (dataJson) {
                try {
                    const parsed = JSON.parse(dataJson);
                    if (parsed && typeof parsed === 'object') {
                        map = parsed;
                    }
                } catch (err) {
                    console.warn("Failed to parse map, using empty map:", err);
                }
            }
            map[dateStr] = count;
            localStorage.setItem('sj_stats_max_observed_counts', JSON.stringify(map));
        } catch (e) {
            console.warn("Failed to set sj_stats_max_observed_counts:", e);
        }
    };

    // 每日已观测审核工单 ID 集合管理 (v3.5, v3.6 过滤自愈历史污染日期字符串)
    const getObservedIdsForDate = (dateStr) => {
        try {
            const dataJson = localStorage.getItem('sj_stats_observed_ids_by_date');
            if (dataJson) {
                const map = JSON.parse(dataJson);
                if (map && typeof map === 'object' && map[dateStr] && Array.isArray(map[dateStr])) {
                    // 过滤掉因为旧版(v3.4)无 id 缓存而混入的 reviewedtime 格式 ID (带横杠和冒号的日期时间字符串)
                    const cleaned = map[dateStr].filter(id => {
                        if (typeof id === 'string' && id.includes('-') && id.includes(':')) {
                            return false;
                        }
                        return true;
                    });
                    return cleaned;
                }
            }
        } catch (e) {
            console.warn("Failed to read sj_stats_observed_ids_by_date:", e);
        }
        return [];
    };

    const setObservedIdsForDate = (dateStr, idsList) => {
        try {
            let map = {};
            const dataJson = localStorage.getItem('sj_stats_observed_ids_by_date');
            if (dataJson) {
                try {
                    const parsed = JSON.parse(dataJson);
                    if (parsed && typeof parsed === 'object') {
                        map = parsed;
                    }
                } catch (err) {
                    console.warn("Failed to parse map, using empty map:", err);
                }
            }
            // 同样过滤后再写入，保持数据纯净
            map[dateStr] = idsList.filter(id => {
                if (typeof id === 'string' && id.includes('-') && id.includes(':')) {
                    return false;
                }
                return true;
            });
            localStorage.setItem('sj_stats_observed_ids_by_date', JSON.stringify(map));
        } catch (e) {
            console.warn("Failed to set sj_stats_observed_ids_by_date:", e);
        }
    };

    // 清洗已观测 ID 集合，移除非数字ID，以及把由于时区等差异被错误归类到其它日期的 ID 剔除 (v3.6.1 自愈自净化)
    const sanitizeAllObservedIds = (allRecords) => {
        try {
            const dataJson = localStorage.getItem('sj_stats_observed_ids_by_date');
            if (!dataJson) return;
            const map = JSON.parse(dataJson);
            if (!map || typeof map !== 'object') return;

            // 1. 建立 ID 到实际日期(YYYY-MM-DD)的映射关系
            const idToDateMap = new Map();
            allRecords.forEach(item => {
                const id = item.id || item.orderid || item.taskid;
                if (id && item.reviewedtime) {
                    const dateStr = item.reviewedtime.substring(0, 10);
                    idToDateMap.set(String(id), dateStr);
                    idToDateMap.set(Number(id), dateStr);
                }
            });

            let changed = false;
            // 2. 遍历 localStorage 中的每个日期
            for (const dateStr in map) {
                if (Array.isArray(map[dateStr])) {
                    const originalLength = map[dateStr].length;
                    const cleaned = map[dateStr].filter(id => {
                        // 过滤掉因为旧版(v3.4)无 id 缓存而混入的 reviewedtime 格式 ID (带横杠和冒号的日期时间字符串)
                        if (typeof id === 'string' && id.includes('-') && id.includes(':')) {
                            return false;
                        }
                        // 如果该 ID 存在于我们拉取的实际记录中，但其实际审核日期不等于当前分组日期，则说明是跨天污染，予以过滤剔除
                        const realDate = idToDateMap.get(id);
                        if (realDate && realDate !== dateStr) {
                            return false;
                        }
                        return true;
                    });
                    if (cleaned.length !== originalLength) {
                        map[dateStr] = cleaned;
                        changed = true;
                    }
                }
            }
            if (changed) {
                localStorage.setItem('sj_stats_observed_ids_by_date', JSON.stringify(map));
                console.log("Sanitized sj_stats_observed_ids_by_date successfully.");
            }
        } catch (e) {
            console.warn("Failed to sanitize observed IDs:", e);
        }
    };

    // 动态注入 Google Fonts 字体
    const fontLink = document.createElement('link');
    fontLink.rel = 'stylesheet';
    fontLink.href = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap';
    document.head.appendChild(fontLink);

    // 样式注入 (UI 3.4)
    GM_addStyle(`
        /* 悬浮球容器样式 */
        #sj-stats-float-btn {
            position: fixed;
            bottom: 24px;
            right: 24px;
            background: rgba(15, 23, 42, 0.95);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(59, 130, 246, 0.4);
            box-shadow: 0 4px 20px rgba(59, 130, 246, 0.25);
            color: #3b82f6;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            z-index: 99999;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            user-select: none;
            box-sizing: border-box;
            overflow: hidden;
            white-space: nowrap;
        }

        /* 迷你模式 */
        #sj-stats-float-btn.sj-hud-min {
            width: 56px;
            height: 56px;
            border-radius: 50%;
            overflow: visible;
        }
        #sj-stats-float-btn.sj-hud-min:hover {
            transform: scale(1.1) translateY(-3px);
            border-color: #60a5fa;
            box-shadow: 0 8px 30px rgba(59, 130, 246, 0.5);
            color: #60a5fa;
        }

        /* 展开 HUD 状态条模式 */
        #sj-stats-float-btn.sj-hud-exp {
            width: auto;
            height: 38px;
            border-radius: 19px;
            padding: 0 16px;
            gap: 12px;
            min-width: 290px;
            overflow: hidden;
        }
        #sj-stats-float-btn.sj-hud-exp:hover {
            border-color: #60a5fa;
            box-shadow: 0 6px 24px rgba(59, 130, 246, 0.45);
        }

        #sj-stats-float-btn.sj-dragging {
            transition: none !important;
            cursor: grabbing !important;
            transform: none !important;
        }
        #sj-stats-float-btn svg {
            width: 20px;
            height: 20px;
            fill: currentColor;
        }

        /* HUD 文本与样式 */
        .sj-hud-text {
            font-size: 11.5px;
            color: #cbd5e1;
            font-weight: 500;
        }
        .sj-hud-divider {
            color: rgba(255, 255, 255, 0.12);
            font-weight: 300;
        }

        /* 进度徽标样式 */
        #sj-stats-badge {
            position: absolute;
            top: -5px;
            right: -5px;
            background: rgba(9, 13, 22, 0.95);
            border: 1px solid rgba(59, 130, 246, 0.5);
            box-shadow: 0 0 10px rgba(59, 130, 246, 0.3);
            color: #3b82f6;
            font-size: 10px;
            font-weight: 700;
            padding: 1px 5px;
            border-radius: 10px;
            pointer-events: none;
            white-space: nowrap;
            display: none;
            transition: all 0.3s ease;
            font-family: 'Plus Jakarta Sans', sans-serif;
            z-index: 100000;
        }
        #sj-stats-badge.met {
            border-color: rgba(16, 185, 129, 0.6);
            color: #10b981;
            box-shadow: 0 0 12px rgba(16, 185, 129, 0.45);
        }

        /* 模态框遮罩 */
        #sj-stats-modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(2, 6, 23, 0.75);
            backdrop-filter: blur(12px);
            z-index: 100000;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.3s ease;
        }
        #sj-stats-modal-overlay.active {
            opacity: 1;
            pointer-events: auto;
        }

        /* 模态框卡片 (暗黑玻璃拟态) */
        #sj-stats-card {
            background: #090d16;
            color: #f1f5f9;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 20px;
            width: 720px;
            max-width: 95%;
            max-height: 90vh;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 50px rgba(59, 130, 246, 0.04);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
            transform: scale(0.92);
            transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        #sj-stats-modal-overlay.active #sj-stats-card {
            transform: scale(1);
        }

        /* 头部设计 */
        .sj-card-header {
            background: linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%);
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
            padding: 20px 24px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            position: relative;
        }
        .sj-card-title {
            margin: 0;
            font-size: 17px;
            font-weight: 700;
            background: linear-gradient(135deg, #ffffff 0%, #94a3b8 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            letter-spacing: 0.5px;
        }
        .sj-card-close {
            background: none;
            border: none;
            color: #475569;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 4px;
            border-radius: 6px;
            transition: all 0.2s;
        }
        .sj-card-close:hover {
            background: rgba(255, 255, 255, 0.05);
            color: #ffffff;
        }
        .sj-card-close svg {
            width: 18px;
            height: 18px;
            fill: currentColor;
        }

        /* 日期选择器容器 */
        .sj-date-picker-bar {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
            background: rgba(255, 255, 255, 0.01);
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
            padding: 12px 24px;
        }
        .sj-date-btn {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 8px;
            padding: 7px 14px;
            font-size: 13px;
            font-weight: 600;
            color: #94a3b8;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            transition: all 0.2s;
            user-select: none;
        }
        .sj-date-btn:hover:not(:disabled) {
            background: rgba(255, 255, 255, 0.08);
            border-color: rgba(255, 255, 255, 0.2);
            color: #ffffff;
        }
        .sj-date-btn:disabled {
            opacity: 0.2;
            cursor: not-allowed;
        }
        .sj-date-btn svg {
            width: 14px;
            height: 14px;
            fill: currentColor;
        }
        .sj-date-input {
            border: 1px solid rgba(255, 255, 255, 0.10);
            border-radius: 8px;
            padding: 6px 12px;
            font-size: 13px;
            font-weight: 600;
            color: #ffffff;
            outline: none;
            background: rgba(15, 23, 42, 0.6);
            cursor: pointer;
            text-align: center;
            font-family: inherit;
            color-scheme: dark;
            transition: border-color 0.2s;
        }
        .sj-date-input:focus {
            border-color: #3b82f6;
        }

        /* 内容区域 */
        .sj-card-body {
            padding: 24px;
            overflow-y: auto;
            color: #cbd5e1;
            display: flex;
            flex-direction: column;
            gap: 24px;
        }

        /* 自定义窄滚动条 */
        .sj-card-body::-webkit-scrollbar {
            width: 6px;
        }
        .sj-card-body::-webkit-scrollbar-track {
            background: transparent;
        }
        .sj-card-body::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.08);
            border-radius: 3px;
        }
        .sj-card-body::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.18);
        }

        /* 统计区块 (高品质卡片) */
        .sj-stats-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 16px;
        }
        .sj-stats-box {
            border-radius: 16px;
            padding: 20px 16px;
            text-align: center;
            position: relative;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 6px;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .sj-stats-box::before {
            content: '';
            position: absolute;
            top: 0; left: 0; width: 100%; height: 100%;
            background: linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%);
            pointer-events: none;
        }
        .sj-box-blue {
            background: rgba(15, 23, 42, 0.45);
            border: 1px solid rgba(59, 130, 246, 0.15);
            backdrop-filter: blur(8px);
        }
        .sj-box-blue:hover {
            border-color: rgba(59, 130, 246, 0.45);
            box-shadow: 0 12px 30px rgba(59, 130, 246, 0.12);
            transform: translateY(-3px);
        }
        .sj-box-purple {
            background: rgba(15, 23, 42, 0.45);
            border: 1px solid rgba(168, 85, 247, 0.15);
            backdrop-filter: blur(8px);
        }
        .sj-box-purple:hover {
            border-color: rgba(168, 85, 247, 0.45);
            box-shadow: 0 12px 30px rgba(168, 85, 247, 0.12);
            transform: translateY(-3px);
        }
        .sj-box-amber {
            background: rgba(15, 23, 42, 0.45);
            border: 1px solid rgba(245, 158, 11, 0.15);
            backdrop-filter: blur(8px);
        }
        .sj-box-amber:hover {
            border-color: rgba(245, 158, 11, 0.45);
            box-shadow: 0 12px 30px rgba(245, 158, 11, 0.12);
            transform: translateY(-3px);
        }
        .sj-stats-box-label {
            font-size: 11.5px;
            color: #64748b;
            font-weight: 600;
            letter-spacing: 0.5px;
        }
        .sj-stats-box-value {
            font-size: 32px;
            font-weight: 700;
            line-height: 1;
        }
        .sj-text-blue { color: #3b82f6; text-shadow: 0 0 15px rgba(59, 130, 246, 0.3); }
        .sj-text-purple { color: #a855f7; text-shadow: 0 0 15px rgba(168, 85, 247, 0.3); }
        .sj-text-amber { color: #f59e0b; text-shadow: 0 0 15px rgba(245, 158, 11, 0.3); }

        /* 图表容器 */
        .sj-chart-wrapper {
            position: relative;
            background: rgba(255, 255, 255, 0.01);
            border: 1px solid rgba(255, 255, 255, 0.04);
            border-radius: 16px;
            padding: 16px 12px 10px 12px;
        }
        .sj-chart-title {
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 4px;
            margin-left: 8px;
            color: #94a3b8;
        }
        #sj-stats-chart-div {
            width: 100%;
            height: 200px;
        }

        /* 列表明细样式 */
        .sj-details-wrapper {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .sj-details-title {
            font-size: 13px;
            font-weight: 600;
            color: #94a3b8;
        }
        .sj-details-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
        }
        .sj-details-table th, .sj-details-table td {
            padding: 11px 16px;
            text-align: left;
        }
        .sj-details-table th {
            background: rgba(255, 255, 255, 0.02);
            color: #64748b;
            font-weight: 600;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            font-size: 12px;
        }
        .sj-details-table td {
            border-bottom: 1px solid rgba(255, 255, 255, 0.03);
            color: #cbd5e1;
        }
        .sj-details-table tr:hover {
            background: rgba(255, 255, 255, 0.02);
        }

        /* 加载动画 */
        .sj-loading-overlay {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 60px 0;
        }
        .sj-spinner {
            border: 3px solid rgba(255, 255, 255, 0.04);
            width: 32px;
            height: 32px;
            border-radius: 50%;
            border-left-color: #3b82f6;
            animation: sj-spin 0.8s linear infinite;
            margin-bottom: 16px;
        }
        @keyframes sj-spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        /* 选项卡切换样式 (v1.8) */
        .sj-tab-item {
            user-select: none;
            position: relative;
            padding: 10px 4px;
            font-size: 13px;
            font-weight: 600;
            color: #64748b;
            border-bottom: 2px solid transparent;
            cursor: pointer;
            transition: all 0.2s;
            height: 100%;
            display: flex;
            align-items: center;
            box-sizing: border-box;
        }
        .sj-tab-item:hover {
            color: #f1f5f9;
        }
        .sj-tab-item.active {
            color: #3b82f6;
            border-bottom-color: #3b82f6;
        }
        .sj-collapsed-card {
            height: 38px !important;
            overflow: hidden !important;
            opacity: 0.65;
            position: relative;
            border: 1px dashed #dcdfe6 !important;
            background-color: #f5f7fa !important;
            transition: all 0.2s ease-in-out;
        }
        .sj-collapsed-card:hover {
            opacity: 1;
            background-color: #ecf5ff !important;
            border-color: #c6e2ff !important;
        }
        .sj-collapsed-card * {
            pointer-events: none !important;
        }
        .sj-collapsed-card .sj-collapse-toggle-btn {
            pointer-events: auto !important;
        }
        .question-detail-text.el-popover__reference,
        .question-detail-text,
        .question-detail {
            pointer-events: none !important;
            user-select: none !important;
        }

        /* 一键通过审核悬浮按钮优化 */
        #sj-auto-review-btn {
            position: fixed;
            top: 50%;
            right: 12px;
            transform: translateY(-50%);
            z-index: 999998;
            background: rgba(9, 13, 22, 0.9);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(16, 185, 129, 0.4);
            box-shadow: 0 4px 20px rgba(16, 185, 129, 0.25);
            color: #10b981;
            padding: 10px 16px;
            border-radius: 12px;
            cursor: pointer;
            font-size: 13.5px;
            font-weight: 600;
            font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            user-select: none;
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            box-sizing: border-box;
            outline: none;
        }
        #sj-auto-review-btn:hover:not(:disabled) {
            background: rgba(16, 185, 129, 0.15);
            border-color: rgba(16, 185, 129, 0.8);
            color: #34d399;
            box-shadow: 0 8px 30px rgba(16, 185, 129, 0.45);
            transform: scale(1.04);
        }
        #sj-auto-review-btn:active:not(:disabled) {
            transform: scale(0.96);
        }
        #sj-auto-review-btn.sj-dragging {
            transition: none !important;
            cursor: grabbing !important;
            transform: none !important;
        }
        #sj-auto-review-btn:disabled {
            background: rgba(15, 23, 42, 0.6);
            border-color: rgba(255, 255, 255, 0.08);
            color: #64748b;
            cursor: not-allowed;
            box-shadow: none;
        }
        #sj-auto-review-btn svg {
            width: 15px;
            height: 15px;
            fill: none;
            stroke: currentColor;
            stroke-width: 2.5;
            stroke-linecap: round;
            stroke-linejoin: round;
            flex-shrink: 0;
            transition: stroke 0.3s ease;
        }
        #sj-skip-order-btn {
            position: fixed;
            top: calc(50% + 52px);
            right: 12px;
            z-index: 999998;
            min-width: 118px;
            padding: 9px 14px;
            border: 1px solid rgba(245, 158, 11, 0.5);
            border-radius: 12px;
            color: #fbbf24;
            background: rgba(9, 13, 22, 0.92);
            box-shadow: 0 4px 20px rgba(245, 158, 11, 0.22);
            backdrop-filter: blur(12px);
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
            font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
            transition: all 0.2s ease;
        }
        #sj-skip-order-btn:hover:not(:disabled) {
            color: #fcd34d;
            border-color: rgba(245, 158, 11, 0.9);
            background: rgba(245, 158, 11, 0.13);
            box-shadow: 0 7px 24px rgba(245, 158, 11, 0.35);
        }
        #sj-skip-order-btn:disabled {
            color: #64748b;
            border-color: rgba(255, 255, 255, 0.08);
            background: rgba(15, 23, 42, 0.65);
            cursor: not-allowed;
            box-shadow: none;
        }
        #sj-photo-edit-shortcut-btn {
            position: fixed;
            left: 96px;
            top: 96px;
            z-index: 1000001;
            height: 34px;
            padding: 0 14px;
            border: 1px solid rgba(64, 158, 255, 0.8);
            border-radius: 8px;
            background: rgba(9, 13, 22, 0.9);
            color: #40a9ff;
            font-size: 13px;
            font-weight: 700;
            cursor: pointer;
            box-shadow: 0 4px 16px rgba(64, 158, 255, 0.25);
        }
        #sj-photo-edit-shortcut-btn:hover {
            background: rgba(16, 34, 58, 0.98);
            border-color: #40a9ff;
        }
        #sj-photo-edit-shortcut-btn.sj-dragging {
            cursor: grabbing !important;
        }

        /* 克隆图片容器布局与列表样式重置 */
        .sj-cloned-q5-evidence {
            display: flex !important;
            flex-direction: row !important;
            flex-wrap: wrap !important;
            list-style: none !important;
            list-style-type: none !important;
            padding: 0 !important;
            margin: 0 !important;
            gap: 8px !important;
        }
        .sj-cloned-q5-evidence li {
            list-style: none !important;
            list-style-type: none !important;
            display: inline-block !important;
            margin: 0 !important;
            padding: 0 !important;
        }

        /* 智能大图联动审核工作台样式 */
        #sj-zoom-workspace {
            position: fixed;
            left: 20px;
            top: 80px;
            width: 350px;
            bottom: 80px;
            z-index: 200000;
            background: rgba(15, 23, 42, 0.95);
            backdrop-filter: blur(16px);
            border: 1px solid rgba(59, 130, 246, 0.3);
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.6);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            font-family: 'Plus Jakarta Sans', sans-serif;
            box-sizing: border-box;
        }
        .sj-ws-title {
            background: rgba(30, 41, 59, 0.5);
            padding: 14px 16px;
            font-size: 13px;
            font-weight: 600;
            color: #e2e8f0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .sj-ws-tabs {
            display: flex;
            gap: 6px;
            padding: 8px 12px;
            overflow-x: auto;
            background: rgba(30, 41, 59, 0.3);
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
            scrollbar-width: none;
        }
        .sj-ws-tabs::-webkit-scrollbar {
            display: none;
        }
        .sj-ws-tab {
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 11px;
            font-weight: 700;
            color: #94a3b8;
            cursor: pointer;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            white-space: nowrap;
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid rgba(255, 255, 255, 0.02);
        }
        .sj-ws-tab:hover {
            color: #cbd5e1;
            background: rgba(255, 255, 255, 0.06);
        }
        .sj-ws-tab.active {
            background: rgba(59, 130, 246, 0.2);
            color: #3b82f6;
            border-color: rgba(59, 130, 246, 0.4);
        }
        .sj-ws-list {
            flex: 1;
            overflow-y: auto;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 7px;
        }
        .sj-ws-row {
            display: grid;
            grid-template-columns: 18px minmax(0, 1fr) auto;
            align-items: center;
            gap: 8px;
            padding: 9px 10px;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid rgba(255, 255, 255, 0.04);
            cursor: pointer;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            user-select: none;
            min-height: 40px;
        }
        .sj-ws-row:hover {
            background: rgba(255, 255, 255, 0.06);
            border-color: rgba(255, 255, 255, 0.08);
        }
        .sj-ws-row.checked {
            border-color: rgba(16, 185, 129, 0.3);
            background: rgba(16, 185, 129, 0.05);
        }
        .sj-ws-row.pending {
            border-color: rgba(245, 158, 11, 0.34);
            background: rgba(245, 158, 11, 0.055);
        }
        .sj-ws-icon {
            width: 16px;
            height: 16px;
            border: 1px solid #64748b;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            color: transparent;
            background: rgba(255, 255, 255, 0.02);
            flex-shrink: 0;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .sj-ws-icon.checked {
            border-color: #10b981;
            background: #10b981;
            color: #ffffff;
        }
        .sj-ws-icon.checked:not([style*="border-radius: 4px"]) {
            color: #10b981;
            background: transparent;
            font-size: 12px;
        }
        .sj-ws-label {
            font-size: 12px;
            color: #cbd5e1;
            line-height: 1.35;
            min-width: 0;
            overflow-wrap: anywhere;
        }
        .sj-ws-row.verified {
            background: rgba(16, 185, 129, 0.035) !important;
            border-color: rgba(16, 185, 129, 0.22) !important;
        }
        .sj-ws-row.verified .sj-ws-label {
            color: #99f6e4 !important;
        }
        .sj-ws-verify-btn {
            flex-shrink: 0;
            white-space: nowrap;
            margin-left: auto;
            width: 42px;
            height: 22px;
            padding: 0;
            font-size: 11px;
            line-height: 20px;
            font-weight: 700;
            border-radius: 999px;
            cursor: pointer;
            user-select: none;
            text-align: center;
            font-family: inherit;
            appearance: none;
            outline: none;
            transition: background 0.16s ease-out, border-color 0.16s ease-out, color 0.16s ease-out;
        }
        .sj-ws-verify-btn:focus-visible {
            box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.35);
        }
        .sj-ws-verify-btn.pending {
            background: rgba(245, 158, 11, 0.12);
            border: 1px solid rgba(245, 158, 11, 0.46);
            color: #fcd34d;
        }
        .sj-ws-verify-btn.pending:hover {
            background: rgba(245, 158, 11, 0.2);
            border-color: rgba(245, 158, 11, 0.62);
            color: #fde68a;
        }
        .sj-ws-verify-btn.verified {
            background: rgba(20, 184, 166, 0.14);
            border: 1px solid rgba(45, 212, 191, 0.32);
            color: #5eead4;
        }
        .sj-ws-verify-btn.verified:hover {
            background: rgba(20, 184, 166, 0.22);
            border-color: rgba(45, 212, 191, 0.5);
            color: #99f6e4;
        }
        .sj-ws-fill-row {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 10px 12px;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid rgba(255, 255, 255, 0.05);
        }
        .sj-ws-fill-label {
            font-size: 12px;
            line-height: 1.35;
            color: #cbd5e1;
            font-weight: 600;
        }
        .sj-ws-fill-input {
            width: 100%;
            box-sizing: border-box;
            border: 1px solid rgba(148, 163, 184, 0.35);
            border-radius: 6px;
            background: rgba(15, 23, 42, 0.85);
            color: #f8fafc;
            font-size: 13px;
            line-height: 1.4;
            padding: 8px 10px;
            outline: none;
        }
        .sj-ws-fill-input:focus {
            border-color: rgba(59, 130, 246, 0.8);
            box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.18);
        }
        .sj-ws-empty {
            padding: 14px 12px;
            border-radius: 8px;
            color: #94a3b8;
            font-size: 12px;
            line-height: 1.5;
            background: rgba(255, 255, 255, 0.02);
            border: 1px dashed rgba(148, 163, 184, 0.25);
        }
    `);
    // 全局今日数据缓存 (v2.8)
    let globalTodayRecords = [];

    // 更新悬浮UI状态（迷你HUD / 经典悬浮球）(v2.8)
    const updateFloatingUI = (records) => {
        const btn = document.getElementById('sj-stats-float-btn');
        if (!btn) return;

        // 缓存今日数据以供切换HUD模式时使用
        globalTodayRecords = records;

        const todayStr = formatDate(new Date());
        const target = getTargetForDate(todayStr);
        const hourlyStats = Array.from({ length: 24 }, () => 0);
        const hourlyReworkStats = Array.from({ length: 24 }, () => 0);

        records.forEach(item => {
            if (item.reviewedtime) {
                let hour = parseInt(item.reviewedtime.substring(11, 13), 10);
                if (!isNaN(hour)) {
                    if (hour === 8) hour = 9;
                    else if (hour === 12) hour = 11;
                    else if (hour === 18) hour = 17;
                    if (hour >= 0 && hour < 24) {
                        if (isFirstRoundAudit(item)) {
                            hourlyStats[hour]++;
                        } else {
                            hourlyReworkStats[hour]++;
                        }
                    }
                }
            }
        });

        const displayHours = [9, 10, 11, 13, 14, 15, 16, 17];
        let todayFirstRound = 0;
        let todayRework = 0;
        // 统计全天所有24小时的总初审和总复审量，防止遗漏排班时段外的加班审核 (v3.6.2)
        for (let h = 0; h < 24; h++) {
            todayFirstRound += hourlyStats[h];
            todayRework += hourlyReworkStats[h];
        }
        let todayTotal = todayFirstRound + todayRework;

        // 目标达成时触发洒花特效（基于今日初审量，且每天仅触发一次）
        if (todayFirstRound >= target) {
            const firedDate = localStorage.getItem('sj_stats_confetti_fired_date');
            if (firedDate !== todayStr) {
                if (typeof confetti === 'function') {
                    confetti({
                        particleCount: 120,
                        spread: 80,
                        origin: { y: 0.6 }
                    });
                }
                localStorage.setItem('sj_stats_confetti_fired_date', todayStr);
            }
        }

        // 计算当前展示时速（与 Card 2 保持同步，采用基于实际订单间隔的间隔积分算法）
        const now = new Date();
        const nowHour = now.getHours();
        let targetHour = nowHour;
        if (nowHour === 8) targetHour = 9;
        else if (nowHour === 12) targetHour = 11;
        else if (nowHour === 18) targetHour = 17;

        const isCoreHour = displayHours.includes(targetHour);
        let curHourSpeed = '0.0';
        const activeInfo = calculateActiveTime(records, todayStr);
        
        if (isCoreHour) {
            // 核心工时段：显示本小时（初审+复审）综合时速
            const curHourActiveHours = activeInfo.hourlyActiveHours[targetHour] || 0;
            const curHourTotal = (hourlyStats[targetHour] || 0) + (hourlyReworkStats[targetHour] || 0);
            curHourSpeed = curHourActiveHours > 0 ? (curHourTotal / curHourActiveHours).toFixed(1) : '0.0';
        } else {
            // 非核心时段：显示今日累计综合均速（初审+复审）
            let activeHoursSum = 0;
            displayHours.forEach(h => {
                if (hourlyStats[h] > 0 || hourlyReworkStats[h] > 0) {
                    activeHoursSum += activeInfo.hourlyActiveHours[h] || 0;
                }
            });
            curHourSpeed = activeHoursSum > 0 ? (todayTotal / activeHoursSum).toFixed(1) : '0.0';
        }


        const mode = localStorage.getItem('sj_stats_hud_mode') || 'min';

        // 同步状态 class
        const isDragging = btn.classList.contains('sj-dragging');
        if (mode === 'exp') {
            btn.className = isDragging ? 'sj-dragging sj-hud-exp' : 'sj-hud-exp';

            const remainingVal = target - todayFirstRound;
            const remainingText = remainingVal <= 0
                ? `<span style="color: #10b981; font-weight: 700;">已达标! 🎉</span>`
                : `还差: <span style="color: #f59e0b; font-weight: 700;">${remainingVal}</span> 单`;

            const todayTextHtml = todayRework > 0
                ? `<span style="color: #3b82f6; font-weight: 700;">${todayFirstRound}</span>(<span style="color: #a855f7;">${todayTotal}</span>)/<span style="color: #64748b;">${target}</span>`
                : `<span style="color: #3b82f6; font-weight: 700;">${todayFirstRound}</span>/<span style="color: #64748b;">${target}</span>`;

            btn.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px; width: 100%; height: 100%; justify-content: center; font-family: 'Plus Jakarta Sans', sans-serif;">
                    <svg viewBox="0 0 24 24" style="width: 15px; height: 15px; fill: currentColor; flex-shrink: 0; margin-top: 1px;">
                        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/>
                    </svg>
                    <span class="sj-hud-text" style="font-size: 11.5px; color: #cbd5e1; white-space: nowrap;">
                        初审: ${todayTextHtml}
                    </span>
                    <span class="sj-hud-divider" style="color: rgba(255, 255, 255, 0.12);">|</span>
                    <span class="sj-hud-text" style="font-size: 11.5px; color: #cbd5e1; white-space: nowrap;">
                        时速: <span style="color: #a855f7; font-weight: 700;">${curHourSpeed}</span>
                    </span>
                    <span class="sj-hud-divider" style="color: rgba(255, 255, 255, 0.12);">|</span>
                    <span class="sj-hud-text" style="font-size: 11.5px; color: #cbd5e1; white-space: nowrap;">
                        ${remainingText}
                    </span>
                </div>
            `;
        } else {
            btn.className = isDragging ? 'sj-dragging sj-hud-min' : 'sj-hud-min';
            btn.innerHTML = `
                <svg viewBox="0 0 24 24">
                    <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/>
                </svg>
                <div id="sj-stats-badge"></div>
            `;
            const badge = document.getElementById('sj-stats-badge');
            if (badge) {
                badge.innerText = `${todayFirstRound}/${target}`;
                badge.style.display = 'block';
                if (todayFirstRound >= target) {
                    badge.classList.add('met');
                } else {
                    badge.classList.remove('met');
                }
            }
        }
        btn.title = `审核数据统计助手 (Alt + S) [双击切换HUD模式]\n今日初审: ${todayFirstRound} 单\n今日复审: ${todayRework} 单\n累计总量: ${todayTotal} 单\n当前目标: ${target} 单`;
    };

        // 切换 HUD 状态 (v2.8)
    const toggleHudMode = () => {
        const currentMode = localStorage.getItem('sj_stats_hud_mode') || 'min';
        const newMode = currentMode === 'min' ? 'exp' : 'min';
        localStorage.setItem('sj_stats_hud_mode', newMode);
        updateFloatingUI(globalTodayRecords);
    };

    // 初始化加载悬浮按钮数据（静默拉取）(v2.2)
    const initFloatBadge = async () => {
        const token = localStorage.getItem('token');
        if (!token) return;
        try {
            const todayStr = formatDate(new Date());
            const records = await fetchRecordsForDate(token, todayStr);
            updateFloatingUI(records);
        } catch (e) {
            console.warn("Failed to initialize float badge count:", e);
        }
    };

    // 自动静默刷新今日数据逻辑 (v2.2支持可见性挂起)
    const startAutoRefresh = () => {
        stopAutoRefresh();
        autoRefreshInterval = setInterval(async () => {
            if (document.hidden) return; // 页面隐藏时暂停后台请求，节约带宽与防爆频

            const overlay = document.getElementById('sj-stats-modal-overlay');
            if (overlay && overlay.classList.contains('active')) {
                const token = localStorage.getItem('token');
                if (!token) return;
                const dateStr = formatDate(currentDate);
                const todayStr = formatDate(new Date());

                if (currentTab === 'daily' && dateStr === todayStr) {
                    try {
                        const popover = document.getElementById('sj-target-popover');
                        if (popover && popover.style.display === 'flex') {
                            return; // 用户正在编辑目标，先跳过此次静默刷新，避免冲突或打断输入
                        }

                        // 默默删除今日缓存，重新从网络获取今日最新数据
                        delete queryCache[dateStr];
                        const allRecords = await fetchRecordsForDate(token, dateStr);

                        // 获取昨日同期数据作对比
                        const yestDate = new Date(currentDate);
                        yestDate.setDate(yestDate.getDate() - 1);
                        const yestDateStr = formatDate(yestDate);
                        const yesterdayRecords = await fetchRecordsForDate(token, yestDateStr);

                        // 二次校验确认弹窗没被打开且面板依然处于active，再进行静默重绘
                        const activeOverlay = document.getElementById('sj-stats-modal-overlay');
                        const activePopover = document.getElementById('sj-target-popover');
                        if (activeOverlay && activeOverlay.classList.contains('active') && (!activePopover || activePopover.style.display !== 'flex')) {
                            renderStats(allRecords, yesterdayRecords);
                        }
                    } catch (err) {
                        console.warn("Silent auto-refresh failed:", err);
                    }
                }
            }
        }, 15000);
    };

    const stopAutoRefresh = () => {
        if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
            autoRefreshInterval = null;
        }
    };

    // 全局定时刷新处理器 (v2.8)
    const startBackgroundRefresh = () => {
        // 每 30 秒静默刷新一次今日数据（仅当页面可见且大面板关闭时运行，以防请求频繁）
        setInterval(async () => {
            if (document.hidden) return;
            const overlay = document.getElementById('sj-stats-modal-overlay');
            const overlayActive = overlay && overlay.classList.contains('active');

            // 如果面板已经打开，交由面板的 15s 高频刷新逻辑处理，这里直接跳过
            if (overlayActive) return;

            const token = localStorage.getItem('token');
            if (!token) return;

            try {
                const todayStr = formatDate(new Date());
                delete queryCache[todayStr]; // 清除今日缓存以重新拉取
                const records = await fetchRecordsForDate(token, todayStr);
                updateFloatingUI(records);
            } catch (err) {
                console.warn("Background HUD refresh failed:", err);
            }
        }, 30000);
    };

    // ==========================================
    // 一键通过审核助手功能组 (无 this 闭包版本)
    // ==========================================
    let autoReviewToastEl = null;
    let autoReviewRunning = false; // ③ 执行锁，防止并发触发

    function autoReviewSleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // 触发点击（mousedown+mouseup+click）
    function autoReviewClickEl(el) {
        if (!el) return false;
        const opts = { bubbles: true, cancelable: true };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        return true;
    }

    // 触发精准中心坐标模拟点击（mousedown+mouseup+click）
    function autoReviewClickCenter(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const opts = {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y
        };
        ['mouseover', 'mousemove', 'mousedown', 'mouseup', 'click'].forEach(type => {
            el.dispatchEvent(new MouseEvent(type, opts));
        });
        return true;
    }

    function photoEditGetVisible(selector, root = document) {
        return Array.from(root.querySelectorAll(selector)).find((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        }) || null;
    }

    function photoEditGetDialog() {
        return photoEditGetVisible('.task-review-evidence-dialog.el-dialog, .task-review-evidence-dialog');
    }

    function photoEditFindButtonByTitle(title, root = document) {
        const candidates = Array.from(root.querySelectorAll('button[title], [title]'));
        const matched = candidates.find((el) => (el.getAttribute('title') || '').trim() === title);
        return matched ? (matched.closest('button') || matched) : null;
    }

    async function photoEditStartRectMode() {
        const dialog = photoEditGetDialog();
        if (!dialog) return;

        let rectBtn = photoEditFindButtonByTitle('\u77e9\u5f62', dialog);
        if (!rectBtn) {
            const editBtn =
                dialog.querySelector('.view-toolbar .el-icon-edit') ||
                dialog.querySelector('.view-footer .el-icon-edit') ||
                dialog.querySelector('span.el-icon-edit');
            if (!editBtn) {
                autoReviewToast('未找到图片编辑按钮', true);
                return;
            }
            autoReviewClickEl(editBtn.closest('button') || editBtn);
            for (let i = 0; i < 20; i++) {
                await autoReviewSleep(100);
                rectBtn = photoEditFindButtonByTitle('\u77e9\u5f62', dialog);
                if (rectBtn) break;
            }
        }

        if (!rectBtn) {
            autoReviewToast('未找到矩形标注按钮', true);
            return;
        }
        autoReviewClickEl(rectBtn);
        autoReviewToast('已进入矩形标注，画完按 Enter 保存');
    }

    async function photoEditSaveAndConfirm() {
        const dialog = photoEditGetDialog();
        if (!dialog) return false;

        const saveBtn = photoEditFindButtonByTitle('\u4fdd\u5b58', dialog);
        if (!saveBtn) return false;

        autoReviewClickEl(saveBtn);
        for (let i = 0; i < 20; i++) {
            await autoReviewSleep(100);
            const messageBox = photoEditGetVisible('.el-message-box__wrapper, .el-message-box');
            if (!messageBox) continue;
            const confirmBtn = Array.from(messageBox.querySelectorAll('button')).find((btn) => {
                const text = btn.textContent.trim();
                return text === '\u786e\u5b9a' || text === '\u786e\u8ba4';
            });
            if (confirmBtn) {
                autoReviewClickEl(confirmBtn);
                return true;
            }
        }
        return true;
    }

    function photoEditEnsureShortcutButton() {
        return;

        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'sj-photo-edit-shortcut-btn';
            btn.textContent = '\u7f16\u8f91';
            btn.title = '\u81ea\u52a8\u8fdb\u5165\u77e9\u5f62\u6807\u6ce8\uff0c\u753b\u5b8c\u6309 Enter \u4fdd\u5b58 [\u53ef\u5de6\u952e\u62d6\u52a8\u4f4d\u7f6e]';

            // 读取持久化位置坐标
            const savedX = localStorage.getItem('sj_photo_edit_btn_x');
            const savedY = localStorage.getItem('sj_photo_edit_btn_y');
            if (savedX && savedY) {
                btn.style.left = savedX + 'px';
                btn.style.top = savedY + 'px';
            }

            // 拖拽逻辑实现
            let isDragging = false;
            let startX = 0;
            let startY = 0;
            let initialLeft = 0;
            let initialTop = 0;

            btn.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return; // 仅限鼠标左键拖拽
                isDragging = false;
                startX = e.clientX;
                startY = e.clientY;

                const rect = btn.getBoundingClientRect();
                initialLeft = rect.left;
                initialTop = rect.top;

                btn.classList.add('sj-dragging');
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
                e.preventDefault(); // 阻止默认的文本拖选
            });

            const onMouseMove = (e) => {
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;

                if (!isDragging && Math.sqrt(dx * dx + dy * dy) > 5) {
                    isDragging = true;
                }

                if (isDragging) {
                    let newLeft = initialLeft + dx;
                    let newTop = initialTop + dy;

                    const rect = btn.getBoundingClientRect();
                    const btnWidth = rect.width;
                    const btnHeight = rect.height;
                    const maxLeft = window.innerWidth - btnWidth;
                    const maxTop = window.innerHeight - btnHeight;

                    newLeft = Math.max(0, Math.min(newLeft, maxLeft));
                    newTop = Math.max(0, Math.min(newTop, maxTop));

                    btn.style.left = newLeft + 'px';
                    btn.style.top = newTop + 'px';
                }
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                btn.classList.remove('sj-dragging');

                if (isDragging) {
                    const rect = btn.getBoundingClientRect();
                    localStorage.setItem('sj_photo_edit_btn_x', Math.round(rect.left));
                    localStorage.setItem('sj_photo_edit_btn_y', Math.round(rect.top));
                }
            };

            btn.addEventListener('click', (e) => {
                if (isDragging) {
                    isDragging = false;
                    return;
                }
                photoEditStartRectMode();
            });

            document.body.appendChild(btn);
        }
    }

    // 带坐标点击星级以实现满星选择
    function autoReviewClickStarAt(iconEl, ratio = 1) {
        const rect = iconEl.getBoundingClientRect();
        const x = rect.left + rect.width * ratio - 1;
        const y = rect.top + rect.height / 2;
        const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
        iconEl.dispatchEvent(new MouseEvent('mousemove', opts));
        iconEl.dispatchEvent(new MouseEvent('mousedown', opts));
        iconEl.dispatchEvent(new MouseEvent('mouseup', opts));
        iconEl.dispatchEvent(new MouseEvent('click', opts));
    }

    // 判断星级图标是否可点击
    function autoReviewIsStarItemDisabled(item, icon) {
        if (!item || !icon) return true;
        if (item.classList.contains('is-disabled') || icon.classList.contains('is-disabled')) return true;
        if (icon.offsetParent === null) return true;
        const style = getComputedStyle(icon);
        if (!style) return true; // 安全防护：防止获取 style 失败报错
        if (style.pointerEvents === 'none') return true;
        if (style.cursor === 'not-allowed') return true;
        if (style.visibility === 'hidden' || style.display === 'none') return true;
        return false;
    }

    // 选取当前最大可选星级并点击
    function autoReviewClickHighestAvailableStar(dialog) {
        const rateItems = Array.from(dialog.querySelectorAll('.el-rate__item'));
        for (let i = rateItems.length - 1; i >= 0; i--) {
            const item = rateItems[i];
            const icon = item.querySelector('.el-rate__icon') || item;
            if (!autoReviewIsStarItemDisabled(item, icon)) {
                autoReviewClickStarAt(icon, 1);
                return i + 1;
            }
        }
        return 0;
    }

    // ④ 检测是否所有题目已有判断（通过或不通过），若是则跳过通过步骤
    function autoReviewAllJudged() {
        const reviews = Array.from(document.querySelectorAll('.answer--review'));
        if (reviews.length === 0) return false;
        return reviews.every((review) => {
            const passBtn = review.querySelector('.el-button--success');
            const failBtn = review.querySelector('.el-button--danger');
            // 已点通过：passBtn 不含 is-plain；已点不通过：failBtn 不含 is-plain
            const alreadyPassed = passBtn && !passBtn.classList.contains('is-plain');
            const alreadyFailed = failBtn && !failBtn.classList.contains('is-plain');
            return alreadyPassed || alreadyFailed;
        });
    }

    // 一键通过所有合法题目（不覆盖手动的不通过）
    function autoReviewPassAllQuestions() {
        const reviews = Array.from(document.querySelectorAll('.answer--review'));
        let count = 0;
        let skippedFailed = 0;
        reviews.forEach((review) => {
            const passBtn = review.querySelector('.el-button--success');
            const failBtn = review.querySelector('.el-button--danger');
            if (!passBtn || passBtn.disabled) return;

            if (failBtn && !failBtn.classList.contains('is-plain')) {
                skippedFailed++;
                return;
            }

            if (!passBtn.classList.contains('is-plain')) {
                count++;
                return;
            }

            autoReviewClickEl(passBtn);
            count++;
        });
        if (skippedFailed > 0) {
            autoReviewToast('已跳过 ' + skippedFailed + ' 道你手动选择"不通过"的题目，未做修改', true);
        }
        return count;
    }

    function autoReviewGetFinishButton() {
        return Array.from(document.querySelectorAll('button')).find(
            (b) => b.textContent.trim() === '审核完成'
        );
    }

    // 查找包含确认按钮的可见弹窗
    function autoReviewGetVisibleReviewDialog() {
        const dialogs = Array.from(document.querySelectorAll('.el-dialog__wrapper'));
        return dialogs.find((d) => {
            const style = getComputedStyle(d);
            if (!style || style.display === 'none') return false;
            const hasConfirmBtn = Array.from(d.querySelectorAll('button')).some(
                (b) => b.textContent.trim() === '确认'
            );
            return hasConfirmBtn;
        });
    }

    function autoReviewGetNextOrderButton() {
        return Array.from(document.querySelectorAll('button')).find(
            (b) => b.textContent.trim() === '审核下一单' &&
                !b.disabled && flmIsVisible(b)
        );
    }

    // ==========================================
    // 页面与图片加载优化：关键图片优先、非关键图片延迟，并使用 OSS 预览图减少传输量
    // ==========================================
    let flmImageOptimizerInitialized = false;
    let flmImagePriorityOrderId = '';
    let flmHighPriorityImageCount = 0;

    function flmOptimizeImageUrlForPreview(url, width = 1000) {
        if (!url || typeof url !== 'string' || url.startsWith('data:') || url.startsWith('blob:')) return url;
        if (!url.includes('slicejobs.com') && !url.includes('aliyuncs.com')) return url;
        // 网站自身已经生成的小缩略图无需再次处理。
        if (/\b(?:w|h)_(?:75|90)\b/.test(url)) return url;
        try {
            const parsed = new URL(url, location.href);
            const oldProcess = parsed.searchParams.get('x-oss-process') || '';
            let nextProcess = oldProcess;
            if (oldProcess.includes('image/resize')) {
                nextProcess = oldProcess
                    .replace(/w_\d+/g, `w_${width}`)
                    .replace(/h_\d+/g, '')
                    .replace(/l_\d+/g, `w_${width}`)
                    .replace(/,+/g, ',')
                    .replace(/,$/, '')
                    .replace(/m_pad/g, 'm_lfit');
                if (!nextProcess.includes('/format,webp')) nextProcess += '/format,webp';
                if (!nextProcess.includes('/quality,q_80')) nextProcess += '/quality,q_80';
            } else {
                nextProcess = `image/resize,w_${width}/format,webp/quality,q_80`;
            }
            parsed.searchParams.set('x-oss-process', nextProcess);
            return parsed.toString();
        } catch (error) {
            return url;
        }
    }

    function flmTuneImageElement(img) {
        if (!img || img.nodeType !== Node.ELEMENT_NODE || img.tagName !== 'IMG') return;
        try {
            const currentOrderId = flmGetCurrentOrderId() || '';
            if (flmImagePriorityOrderId !== currentOrderId) {
                flmImagePriorityOrderId = currentOrderId;
                flmHighPriorityImageCount = 0;
            }
            img.decoding = 'async';
            const rect = img.getBoundingClientRect();
            const nearViewport = rect.top < window.innerHeight * 1.5 && rect.bottom > -200;
            if (nearViewport) {
                img.loading = 'eager';
                // 只把最先出现的三张图片设为高优先级，避免几十张图同时抢占详情接口带宽。
                if ('fetchPriority' in img && !img.dataset.flmPriorityAssigned) {
                    img.fetchPriority = flmHighPriorityImageCount < 3 ? 'high' : 'auto';
                    flmHighPriorityImageCount += 1;
                    img.dataset.flmPriorityAssigned = '1';
                }
            } else {
                img.loading = 'lazy';
                if ('fetchPriority' in img) img.fetchPriority = 'low';
            }
            const currentSrc = img.getAttribute('src');
            const optimizedSrc = flmOptimizeImageUrlForPreview(currentSrc, 1000);
            if (optimizedSrc && optimizedSrc !== currentSrc) img.setAttribute('src', optimizedSrc);
        } catch (error) {}
    }

    function flmInjectResourceHints() {
        if (!document.head) {
            document.addEventListener('DOMContentLoaded', flmInjectResourceHints, { once: true });
            return;
        }
        ['https://sjimgpub.slicejobs.com', 'https://sjaudiopub.slicejobs.com'].forEach((href) => {
            if (document.querySelector(`link[rel="preconnect"][href="${href}"]`)) return;
            const link = document.createElement('link');
            link.rel = 'preconnect';
            link.href = href;
            link.crossOrigin = 'anonymous';
            document.head.appendChild(link);
        });
    }

    function flmInitImageOptimizer() {
        if (flmImageOptimizerInitialized) return;
        flmImageOptimizerInitialized = true;

        const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (srcDescriptor && srcDescriptor.get && srcDescriptor.set && !srcDescriptor.set.__flmOptimized) {
            const originalSetter = srcDescriptor.set;
            const optimizedSetter = function(value) {
                return originalSetter.call(this, flmOptimizeImageUrlForPreview(value, 1000));
            };
            optimizedSetter.__flmOptimized = true;
            Object.defineProperty(HTMLImageElement.prototype, 'src', {
                configurable: srcDescriptor.configurable,
                enumerable: srcDescriptor.enumerable,
                get: srcDescriptor.get,
                set: optimizedSetter
            });
        }

        const originalSetAttribute = Element.prototype.setAttribute;
        if (!originalSetAttribute.__flmOptimized) {
            const optimizedSetAttribute = function(name, value) {
                const nextValue = name === 'src' && this.tagName === 'IMG'
                    ? flmOptimizeImageUrlForPreview(value, 1000)
                    : value;
                return originalSetAttribute.call(this, name, nextValue);
            };
            optimizedSetAttribute.__flmOptimized = true;
            Element.prototype.setAttribute = optimizedSetAttribute;
        }

        const startDomObserver = () => {
            flmInjectResourceHints();
            document.querySelectorAll('img').forEach(flmTuneImageElement);
            if (!document.documentElement) return;
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'attributes') {
                        flmTuneImageElement(mutation.target);
                        return;
                    }
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType !== Node.ELEMENT_NODE) return;
                        if (node.tagName === 'IMG') flmTuneImageElement(node);
                        node.querySelectorAll && node.querySelectorAll('img').forEach(flmTuneImageElement);
                    });
                });
            });
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['src']
            });
        };

        if (document.documentElement) startDomObserver();
        else document.addEventListener('DOMContentLoaded', startDomObserver, { once: true });
    }

    // ==========================================
    // 福临门单槽预取：仿照脉动插件，直接调用网站“开始审单”背后的原生请求。
    // 固定从 projectId=7703 的批次列表第一行领取，任何时刻最多暂存一张下一单。
    // ==========================================
    const FLM_PREFETCH_PAGE_URL = '/customer/batch-order-review/table?customerid=51&projectId=7703';
    const FLM_PREFETCH_CUSTOMER_ID = 51;
    const FLM_PREFETCH_PROJECT_ID = 7703;
    const FLM_PREFETCH_SLOT_KEY = 'flm_prefetch_single_slot_v2';
    const FLM_PREFETCH_LOCK_KEY = 'flm_prefetch_single_lock_v2';
    const FLM_PREFETCH_ATTEMPT_PREFIX = 'flm_prefetch_attempt_v2_';
    const FLM_PREFETCH_SLOT_TTL_MS = 25 * 60 * 1000;
    const FLM_PREFETCH_ATTEMPT_TTL_MS = 10 * 60 * 1000;
    const FLM_PREFETCH_RETRY_DELAY_MS = 2000;
    const FLM_AUDIT_JUMP_ARM_TTL_MS = 2 * 60 * 1000;
    const FLM_PENDING_NAV_KEY = 'flm_pending_order_navigation_v1';
    const FLM_PENDING_NAV_TTL_MS = 20 * 1000;
    let flmPrefetchInFlight = false;
    let flmPrefetchJumping = false;
    let flmSkipRunning = false;
    let flmPrefetchRetryTimer = null;
    let flmAuditJumpArm = null;
    let flmAuditInterceptorInitialized = false;
    let flmWarmFrameOrderId = '';
    let flmWarmFramePollTimer = null;
    let flmWarmScheduleOrderId = '';
    let flmPrerenderOrderId = '';
    let flmAuditSubmitConfirmation = null;

    function flmGetCurrentOrderId() {
        const match = location.pathname.match(/\/order\/review\/(\d+)/);
        return match ? match[1] : null;
    }

    function flmReadPrefetchSlot() {
        const raw = localStorage.getItem(FLM_PREFETCH_SLOT_KEY);
        if (!raw) return null;
        try {
            const slot = JSON.parse(raw);
            const sourceOrderId = String(slot && slot.sourceOrderId || '');
            const nextOrderId = String(slot && slot.nextOrderId || '');
            const createdAt = Number(slot && slot.createdAt || 0);
            if (!/^\d+$/.test(sourceOrderId) || !/^\d+$/.test(nextOrderId) ||
                !createdAt || Date.now() - createdAt > FLM_PREFETCH_SLOT_TTL_MS) {
                localStorage.removeItem(FLM_PREFETCH_SLOT_KEY);
                return null;
            }
            return { ...slot, sourceOrderId, nextOrderId, createdAt };
        } catch (error) {
            localStorage.removeItem(FLM_PREFETCH_SLOT_KEY);
            return null;
        }
    }

    function flmWritePrefetchSlot(slot) {
        localStorage.setItem(FLM_PREFETCH_SLOT_KEY, JSON.stringify(slot));
        if (slot && slot.state === 'ready' && /^\d+$/.test(String(slot.nextOrderId || ''))) {
            flmWarmNextOrderRoute(slot.nextOrderId);
        }
    }

    function flmWarmNextOrderRoute(orderId) {
        orderId = String(orderId || '');
        if (window.self !== window.top || !/^\d+$/.test(orderId)) return;
        // Chromium 优先使用完整预渲染：详情接口、页面组件和图片都会在后台准备好。
        if (flmInstallSpeculationPrerender(orderId)) return;
        if (!document.body || flmWarmFrameOrderId === orderId || flmWarmScheduleOrderId === orderId) return;
        flmWarmScheduleOrderId = orderId;

        const startWhenCurrentPageIsIdle = (attempt = 0) => {
            if (flmGetCurrentOrderId() === orderId || flmWarmFrameOrderId === orderId) return;
            const slot = flmReadPrefetchSlot();
            if (!slot || slot.state !== 'ready' || slot.nextOrderId !== orderId) return;
            const visibleLoadingMask = Array.from(document.querySelectorAll('.el-loading-mask')).some((mask) => {
                const style = getComputedStyle(mask);
                return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            });
            if (visibleLoadingMask && attempt < 30) {
                setTimeout(() => startWhenCurrentPageIsIdle(attempt + 1), 300);
                return;
            }
            flmCreateWarmOrderFrame(orderId);
        };

        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => startWhenCurrentPageIsIdle(), { timeout: 1800 });
        } else {
            setTimeout(() => startWhenCurrentPageIsIdle(), 800);
        }
    }

    function flmInstallSpeculationPrerender(orderId) {
        const supportsSpeculationRules = typeof HTMLScriptElement !== 'undefined' &&
            typeof HTMLScriptElement.supports === 'function' &&
            HTMLScriptElement.supports('speculationrules');
        if (!supportsSpeculationRules || !document.head || flmGetCurrentOrderId() === orderId) return false;
        if (flmPrerenderOrderId === orderId && document.getElementById('flm-next-order-speculation')) return true;

        const oldRule = document.getElementById('flm-next-order-speculation');
        if (oldRule) oldRule.remove();
        const target = '/order/review/' + orderId;
        const rule = document.createElement('script');
        rule.id = 'flm-next-order-speculation';
        rule.type = 'speculationrules';
        rule.textContent = JSON.stringify({
            prerender: [{ source: 'list', urls: [target], eagerness: 'immediate' }]
        });
        document.head.appendChild(rule);
        flmPrerenderOrderId = orderId;
        flmWarmScheduleOrderId = '';
        console.log(`[福临门预热] 已提交浏览器完整预渲染订单 ${orderId}。`);
        return true;
    }

    function flmDestroyWarmOrderFrame() {
        if (flmWarmFramePollTimer) {
            clearInterval(flmWarmFramePollTimer);
            flmWarmFramePollTimer = null;
        }
        const oldFrame = document.getElementById('flm-next-order-warm-frame');
        if (oldFrame) oldFrame.remove();
        flmWarmFrameOrderId = '';
        flmWarmScheduleOrderId = '';
        const rule = document.getElementById('flm-next-order-speculation');
        if (rule) rule.remove();
        flmPrerenderOrderId = '';
    }

    function flmCreateWarmOrderFrame(orderId) {
        flmDestroyWarmOrderFrame();
        if (!document.body || flmGetCurrentOrderId() === orderId) return;

        const frame = document.createElement('iframe');
        frame.id = 'flm-next-order-warm-frame';
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        // 保留真实视口尺寸并移出屏幕，确保网站的懒加载逻辑会请求详情图片。
        frame.style.cssText = [
            'position:fixed', 'left:-20000px', 'top:0', 'width:1366px', 'height:900px',
            'opacity:0.01', 'pointer-events:none', 'border:0', 'z-index:-2147483648'
        ].join(';');
        flmWarmFrameOrderId = orderId;
        flmWarmScheduleOrderId = '';
        frame.src = `/order/review/${orderId}?flm_warm=1`;
        document.body.appendChild(frame);

        const startedAt = Date.now();
        flmWarmFramePollTimer = setInterval(() => {
            if (!frame.isConnected || flmWarmFrameOrderId !== orderId) {
                flmDestroyWarmOrderFrame();
                return;
            }
            try {
                const frameDocument = frame.contentDocument;
                const frameWindow = frame.contentWindow;
                if (!frameDocument || !frameWindow ||
                    !frameWindow.location.pathname.includes('/order/review/' + orderId)) return;

                const images = Array.from(frameDocument.images || []);
                images.forEach((img, index) => {
                    const src = img.getAttribute('src');
                    const optimized = flmOptimizeImageUrlForPreview(src, 1000);
                    if (optimized && optimized !== src) img.setAttribute('src', optimized);
                    img.decoding = 'async';
                    img.loading = 'eager';
                    if ('fetchPriority' in img) img.fetchPriority = index < 2 ? 'high' : 'low';
                });

                const hasReviewContent = Boolean(frameDocument.querySelector('.answer--review'));
                const hasVisibleMask = Array.from(frameDocument.querySelectorAll('.el-loading-mask')).some((mask) => {
                    const style = frameWindow.getComputedStyle(mask);
                    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                });
                const loadedImages = images.filter((img) => img.complete && img.naturalWidth > 0).length;
                const detailReady = hasReviewContent && !hasVisibleMask;
                const timedOut = Date.now() - startedAt > 45000;
                if (detailReady || timedOut) {
                    const currentSlot = flmReadPrefetchSlot();
                    if (currentSlot && currentSlot.state === 'ready' && currentSlot.nextOrderId === orderId) {
                        flmWritePrefetchSlot({
                            ...currentSlot,
                            warmState: detailReady ? 'ready' : 'partial',
                            warmedAt: Date.now(),
                            warmedImages: loadedImages,
                            discoveredImages: images.length
                        });
                    }
                    clearInterval(flmWarmFramePollTimer);
                    flmWarmFramePollTimer = null;
                    console.log(`[福临门预热] 订单 ${orderId}：${detailReady ? '详情已就绪' : '部分完成'}，图片 ${loadedImages}/${images.length}。`);
                }
            } catch (error) {
                // 同源页面导航和初始化期间可能暂时不可访问，下一轮继续。
            }
        }, 200);
    }

    function flmFindVueRouter() {
        try {
            const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            const pageDocument = pageWindow.document || document;
            const candidates = [
                pageDocument.querySelector('#app'),
                pageDocument.querySelector('.answer--review'),
                pageDocument.querySelector('.order-review')
            ].filter(Boolean);
            for (const element of candidates) {
                const vm = element.__vue__;
                const router = vm && (vm.$router || vm.$root && vm.$root.$router);
                if (router && typeof router.replace === 'function') return router;
            }
        } catch (error) {}
        return null;
    }

    function flmNavigateToOrder(orderId) {
        orderId = String(orderId || '');
        if (!/^\d+$/.test(orderId)) return false;
        const target = '/order/review/' + orderId;
        const fromOrderId = flmGetCurrentOrderId() || '';
        try {
            // 审核完成后网站还会继续执行弹窗和路由回调。记录目标订单，防止这些回调把页面拉回原单。
            sessionStorage.setItem(FLM_PENDING_NAV_KEY, JSON.stringify({
                fromOrderId,
                targetOrderId: orderId,
                createdAt: Date.now(),
                attempts: 0
            }));

            // 始终使用真正的文档导航：既能激活 Speculation Rules 预渲染，也不会被当前 Vue
            // 组件仍在运行的审核回调通过 router.replace 覆盖。
            location.replace(target);

            // 极慢网络下旧文档可能还存活一段时间；若地址仍未变化，再补发一次相同导航。
            setTimeout(() => {
                if (flmGetCurrentOrderId() !== fromOrderId) return;
                try {
                    const raw = sessionStorage.getItem(FLM_PENDING_NAV_KEY);
                    const pending = raw ? JSON.parse(raw) : null;
                    if (!pending || pending.targetOrderId !== orderId) return;
                    pending.attempts = Number(pending.attempts || 0) + 1;
                    sessionStorage.setItem(FLM_PENDING_NAV_KEY, JSON.stringify(pending));
                    location.replace(target);
                } catch (error) {}
            }, 900);
            return true;
        } catch (error) {
            location.replace(target);
            return true;
        }
    }

    function flmRecoverPendingNavigation() {
        let pending = null;
        try {
            const raw = sessionStorage.getItem(FLM_PENDING_NAV_KEY);
            pending = raw ? JSON.parse(raw) : null;
        } catch (error) {
            sessionStorage.removeItem(FLM_PENDING_NAV_KEY);
            return false;
        }
        if (!pending) return false;

        const currentOrderId = flmGetCurrentOrderId() || '';
        const targetOrderId = String(pending.targetOrderId || '');
        const fromOrderId = String(pending.fromOrderId || '');
        const age = Date.now() - Number(pending.createdAt || 0);
        if (!/^\d+$/.test(targetOrderId) || age < 0 || age > FLM_PENDING_NAV_TTL_MS) {
            sessionStorage.removeItem(FLM_PENDING_NAV_KEY);
            return false;
        }
        if (currentOrderId === targetOrderId) {
            sessionStorage.removeItem(FLM_PENDING_NAV_KEY);
            return false;
        }
        if (currentOrderId !== fromOrderId || Number(pending.attempts || 0) >= 2) {
            sessionStorage.removeItem(FLM_PENDING_NAV_KEY);
            return false;
        }

        pending.attempts = Number(pending.attempts || 0) + 1;
        sessionStorage.setItem(FLM_PENDING_NAV_KEY, JSON.stringify(pending));
        setTimeout(() => location.replace('/order/review/' + targetOrderId), 60);
        return true;
    }

    function flmFinalizePrefetchSlot(currentOrderId) {
        const slot = flmReadPrefetchSlot();
        if (!slot) return null;
        if (slot.nextOrderId === String(currentOrderId) &&
            (slot.state === 'consuming' || slot.state === 'ready')) {
            flmDestroyWarmOrderFrame();
            localStorage.removeItem(FLM_PREFETCH_SLOT_KEY);
            flmPrefetchJumping = false;
            console.log(`[福临门预取] 已进入缓存订单 ${currentOrderId}，单槽已清空。`);
            return null;
        }
        // 如果用户通过网站原生流程或手动导航到了别的待审订单，旧槽中的订单仍然有效。
        // 将它重新绑定到当前订单，下一次继续消费，避免丢单，也避免再额外领取一单。
        if (slot.state === 'ready' && slot.sourceOrderId !== String(currentOrderId)) {
            const rebound = { ...slot, sourceOrderId: String(currentOrderId), reboundAt: Date.now() };
            flmWritePrefetchSlot(rebound);
            console.log(`[福临门预取] 缓存订单 ${slot.nextOrderId} 已重新绑定到当前订单 ${currentOrderId}。`);
            return rebound;
        }
        return slot;
    }

    function flmAcquirePrefetchLock() {
        const now = Date.now();
        try {
            const existing = JSON.parse(localStorage.getItem(FLM_PREFETCH_LOCK_KEY) || 'null');
            if (existing && Number(existing.expiresAt) > now) return null;
        } catch (error) {}
        const token = `${now}_${Math.random().toString(36).slice(2)}`;
        localStorage.setItem(FLM_PREFETCH_LOCK_KEY, JSON.stringify({ token, expiresAt: now + 30000 }));
        try {
            const saved = JSON.parse(localStorage.getItem(FLM_PREFETCH_LOCK_KEY) || 'null');
            return saved && saved.token === token ? token : null;
        } catch (error) {
            return null;
        }
    }

    function flmReleasePrefetchLock(token) {
        try {
            const saved = JSON.parse(localStorage.getItem(FLM_PREFETCH_LOCK_KEY) || 'null');
            if (saved && saved.token === token) localStorage.removeItem(FLM_PREFETCH_LOCK_KEY);
        } catch (error) {}
    }

    function flmGetRequestClient() {
        try {
            const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            const req = pageWindow && pageWindow.request || window.request;
            return req && typeof req.common === 'function' && typeof req.page === 'function' ? req : null;
        } catch (error) {
            return null;
        }
    }

    function flmExtractBatchRows(response) {
        const queue = [response];
        const visited = new Set();
        while (queue.length > 0) {
            const value = queue.shift();
            if (!value || typeof value !== 'object' || visited.has(value)) continue;
            visited.add(value);
            if (Array.isArray(value)) {
                if (value.some((row) => row && (row.batchid || row.batchId))) return value;
                value.forEach((item) => queue.push(item));
                continue;
            }
            ['data', 'list', 'rows', 'items', 'records', 'result'].forEach((key) => {
                if (value[key] !== undefined) queue.push(value[key]);
            });
        }
        return [];
    }

    function flmExtractPrefetchedOrderId(response) {
        const queue = [response];
        const visited = new Set();
        while (queue.length > 0) {
            const value = queue.shift();
            if (typeof value === 'string') {
                const routeMatch = value.match(/\/order\/review\/(\d+)/);
                if (routeMatch) return routeMatch[1];
                continue;
            }
            if (!value || typeof value !== 'object' || visited.has(value)) continue;
            visited.add(value);
            for (const [key, child] of Object.entries(value)) {
                if (/^order_?id$/i.test(key)) {
                    const orderId = String(child || '');
                    if (/^\d+$/.test(orderId)) return orderId;
                }
                if (child && (typeof child === 'object' || typeof child === 'string')) queue.push(child);
            }
        }
        return null;
    }

    function flmSchedulePrefetchRetry(currentOrderId, delayMs = FLM_PREFETCH_RETRY_DELAY_MS) {
        currentOrderId = String(currentOrderId || '');
        if (flmPrefetchRetryTimer || !/^\d+$/.test(currentOrderId)) return;
        if (flmReadPrefetchSlot() || sessionStorage.getItem(FLM_PREFETCH_ATTEMPT_PREFIX + currentOrderId)) return;
        flmPrefetchRetryTimer = setTimeout(() => {
            flmPrefetchRetryTimer = null;
            if (flmGetCurrentOrderId() !== currentOrderId || flmReadPrefetchSlot()) return;
            flmStartPrefetchForCurrentOrder();
        }, delayMs);
    }

    function flmIsAuditSubmitRequest(url, method) {
        if (String(method || '').toUpperCase() !== 'POST') return false;
        const value = String(url || '');
        return (value.includes('/admin/order/audit/') || value.includes('/admin/audit_task/')) &&
            !['/acquire', '/create', '/get', '/detail', '/history', '/info', '/query']
                .some((part) => value.includes(part));
    }

    function flmAuditResponseIsSuccessful(status, responseText) {
        if (Number(status) < 200 || Number(status) >= 300) return false;
        const text = typeof responseText === 'string' ? responseText.trim() : '';
        if (!text) return true;
        try {
            const data = JSON.parse(text);
            if (data && data.success === false) return false;
            if (data && data.code !== undefined && ![0, 200].includes(Number(data.code))) return false;
            if (data && data.status !== undefined && ![0, 200].includes(Number(data.status))) return false;
        } catch (error) {
            // 某些成功接口返回纯文本，HTTP 2xx 即可视为提交成功。
        }
        return true;
    }

    function flmArmAuditPrefetchJump() {
        const currentOrderId = flmGetCurrentOrderId();
        const slot = flmReadPrefetchSlot();
        if (!currentOrderId || !slot || slot.state !== 'ready' ||
            slot.sourceOrderId !== currentOrderId || slot.nextOrderId === currentOrderId) {
            flmAuditJumpArm = null;
            return false;
        }
        flmAuditJumpArm = { currentOrderId, armedAt: Date.now() };
        return true;
    }

    function flmHandleAuditSubmitResponse(meta) {
        const arm = flmAuditJumpArm;
        if (!arm || Date.now() - arm.armedAt > FLM_AUDIT_JUMP_ARM_TTL_MS) {
            flmAuditJumpArm = null;
            return false;
        }
        if (flmGetCurrentOrderId() !== arm.currentOrderId) return false;
        if (!flmAuditResponseIsSuccessful(meta && meta.status, meta && meta.responseText)) {
            flmAuditJumpArm = null;
            return false;
        }
        flmAuditJumpArm = null;
        // 不在 XHR/fetch 的 load 回调中立刻导航。网站自己的成功回调尚未执行完，太早导航会
        // 被“订单已退回/审核成功”弹窗后的路由刷新覆盖，最终重新落回原订单。
        flmAuditSubmitConfirmation = {
            currentOrderId: arm.currentOrderId,
            confirmedAt: Date.now()
        };
        return true;
    }

    function flmInitFastAuditInterceptor() {
        if (flmAuditInterceptorInitialized) return;
        flmAuditInterceptorInitialized = true;

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            this._flmAuditUrl = url;
            this._flmAuditMethod = method;
            return originalOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function(...args) {
            this.addEventListener('load', function() {
                if (!flmIsAuditSubmitRequest(this._flmAuditUrl, this._flmAuditMethod)) return;
                const responseText = typeof this.responseText === 'string' ? this.responseText : '';
                flmHandleAuditSubmitResponse({
                    url: this._flmAuditUrl,
                    status: this.status,
                    responseText
                });
            }, { once: true });
            return originalSend.call(this, ...args);
        };

        const originalFetch = window.fetch;
        if (originalFetch) {
            window.fetch = function(input, initOptions, ...args) {
                const url = typeof input === 'string' ? input : input && input.url || '';
                const method = initOptions && initOptions.method || input && input.method || 'GET';
                return originalFetch.call(this, input, initOptions, ...args).then((response) => {
                    if (flmIsAuditSubmitRequest(url, method)) {
                        try {
                            response.clone().text().then((responseText) => {
                                flmHandleAuditSubmitResponse({ url, status: response.status, responseText });
                            }).catch(() => {});
                        } catch (error) {}
                    }
                    return response;
                });
            };
        }
    }

    function flmPrefetchNextOrder(currentOrderId) {
        currentOrderId = String(currentOrderId || '');
        if (window.self !== window.top || !/^\d+$/.test(currentOrderId)) return Promise.resolve(false);
        if (flmFinalizePrefetchSlot(currentOrderId)) return Promise.resolve(false);
        if (flmPrefetchInFlight) return Promise.resolve(false);

        const attemptKey = FLM_PREFETCH_ATTEMPT_PREFIX + currentOrderId;
        const previousAttempt = Number(sessionStorage.getItem(attemptKey) || 0);
        if (previousAttempt && Date.now() - previousAttempt < FLM_PREFETCH_ATTEMPT_TTL_MS) {
            return Promise.resolve(false);
        }

        const lockToken = flmAcquirePrefetchLock();
        if (!lockToken) return Promise.resolve(false);
        if (flmReadPrefetchSlot()) {
            flmReleasePrefetchLock(lockToken);
            return Promise.resolve(false);
        }

        const req = flmGetRequestClient();
        if (!req) {
            flmReleasePrefetchLock(lockToken);
            return Promise.resolve(false);
        }

        flmPrefetchInFlight = true;
        sessionStorage.setItem(attemptKey, String(Date.now()));
        let allocationStarted = false;
        console.log(`[福临门预取] 正在从 ${FLM_PREFETCH_PAGE_URL} 的第一行领取下一单。`);

        const listParams = {
            batch_name: '',
            current_page: 1,
            per_page: 20,
            projectid: FLM_PREFETCH_PROJECT_ID,
            customerid: FLM_PREFETCH_CUSTOMER_ID
        };

        return Promise.resolve()
            .then(() => req.page('getBatchOrderReviewTable', listParams))
            .then((listResponse) => {
                const rows = flmExtractBatchRows(listResponse);
                const firstRow = rows.find((row) => {
                    const batchId = Number(row && (row.batchid || row.batchId));
                    const projectId = Number(row && (row.projectid || row.projectId) || FLM_PREFETCH_PROJECT_ID);
                    return batchId > 0 && projectId === FLM_PREFETCH_PROJECT_ID;
                });
                if (!firstRow) {
                    sessionStorage.removeItem(attemptKey);
                    console.warn('[福临门预取] 批次列表没有找到可用的第一行“开始审单”。', listResponse);
                    return false;
                }

                const batchId = Number(firstRow.batchid || firstRow.batchId);
                const projectId = Number(firstRow.projectid || firstRow.projectId || FLM_PREFETCH_PROJECT_ID);
                allocationStarted = true;
                return Promise.resolve()
                    .then(() => req.common('createAuditTask', {
                        projectid: projectId,
                        batchid: batchId
                    }))
                    .then((response) => {
                    const nextOrderId = flmExtractPrefetchedOrderId(response);
                    if (!nextOrderId || nextOrderId === currentOrderId) {
                        console.warn('[福临门预取] 开始审单请求未返回有效的新订单号:', response);
                        return false;
                    }
                    if (flmReadPrefetchSlot()) return false;
                    flmWritePrefetchSlot({
                        state: 'ready',
                        sourceOrderId: currentOrderId,
                        nextOrderId,
                        projectId: String(projectId),
                        batchId: String(batchId),
                        createdAt: Date.now()
                    });
                    console.log(`[福临门预取] 单槽已保存第一行批次订单 ${nextOrderId}。`);
                    return true;
                });
            })
            .catch((error) => {
                // 列表请求失败可以在下次 init 重试；领取请求一旦发出则不自动重试，避免重复占单。
                if (!allocationStarted) sessionStorage.removeItem(attemptKey);
                console.error('[福临门预取] 预取失败，本订单将回退网站原生下一单流程:', error);
                return false;
            })
            .finally(() => {
                flmPrefetchInFlight = false;
                flmReleasePrefetchLock(lockToken);
            });
    }

    function flmStartPrefetchForCurrentOrder() {
        // 只允许顶层审单页管理共享单槽。
        if (window.self !== window.top) return;
        const currentOrderId = flmGetCurrentOrderId();
        if (!currentOrderId) return;
        const slot = flmFinalizePrefetchSlot(currentOrderId);
        if (slot) return;
        flmPrefetchNextOrder(currentOrderId).then(() => {
            // 页面脚本或批次列表如果尚未加载好，就继续补试；领取请求已发出时不会重复占单。
            if (flmGetCurrentOrderId() === currentOrderId && !flmReadPrefetchSlot() &&
                !sessionStorage.getItem(FLM_PREFETCH_ATTEMPT_PREFIX + currentOrderId)) {
                flmSchedulePrefetchRetry(currentOrderId);
            }
        });
    }

    function flmConsumeReadySlot(fromOrderId, reason) {
        if (flmPrefetchJumping) return false;
        const slot = flmReadPrefetchSlot();
        fromOrderId = String(fromOrderId || '');
        if (!slot || slot.state !== 'ready' || slot.sourceOrderId !== fromOrderId ||
            slot.nextOrderId === fromOrderId) return false;

        flmPrefetchJumping = true;
        flmWritePrefetchSlot({ ...slot, state: 'consuming', consumedAt: Date.now() });
        autoReviewToast(`${reason}，正在进入已预取订单 ${slot.nextOrderId}...`);
        try {
            return flmNavigateToOrder(slot.nextOrderId);
        } catch (error) {
            flmWritePrefetchSlot({ ...slot, state: 'ready' });
            flmPrefetchJumping = false;
            console.error('[福临门预取] 跳转失败，已恢复缓存槽：', error);
            return false;
        }
    }

    function flmIsVisible(element) {
        if (!element || !element.isConnected) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function flmFindCancelOccupyButton() {
        const nativeCancel = document.querySelector('i.el-alert__closebtn.is-customed');
        if (nativeCancel && flmIsVisible(nativeCancel) &&
            nativeCancel.textContent.replace(/\s+/g, '').includes('取消占有')) return nativeCancel;
        return Array.from(document.querySelectorAll('button,.el-button,[role="button"],i')).find((element) => {
            if (element.id === 'sj-skip-order-btn') return false;
            const disabled = element.disabled || element.getAttribute('aria-disabled') === 'true';
            return !disabled && flmIsVisible(element) &&
                element.textContent.replace(/\s+/g, '').includes('取消占有');
        }) || null;
    }

    async function flmConfirmCancelOccupyDialog(timeoutMs = 1000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const dialogs = Array.from(document.querySelectorAll('.el-message-box__wrapper,.el-dialog__wrapper'));
            const dialog = dialogs.find((element) => {
                const text = element.textContent.replace(/\s+/g, '');
                return flmIsVisible(element) && (text.includes('取消占有') || text.includes('确认取消'));
            });
            if (dialog) {
                const confirmButton = Array.from(dialog.querySelectorAll('button')).find((button) => {
                    const text = button.textContent.trim();
                    return text === '确定' || text === '确认' || button.classList.contains('el-button--primary');
                });
                if (confirmButton) {
                    autoReviewClickEl(confirmButton);
                    return true;
                }
            }
            await autoReviewSleep(50);
        }
        return false;
    }

    async function flmWaitForCancelSuccess(currentOrderId, cancelButton, timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        let stableMissingCount = 0;
        while (Date.now() < deadline) {
            if (flmGetCurrentOrderId() !== currentOrderId) return true;
            const successMessage = Array.from(document.querySelectorAll(
                '.el-message--success,.el-notification.success,.el-notification--success'
            )).find((element) => {
                const text = element.textContent.replace(/\s+/g, '');
                return flmIsVisible(element) && (text.includes('取消') || text.includes('释放'));
            });
            if (successMessage) return true;
            // 网站成功释放后会移除“取消占有”；连续多次确认消失，避免把瞬时重绘误判成成功。
            const currentCancelButton = flmFindCancelOccupyButton();
            if (!cancelButton.isConnected && !currentCancelButton) {
                stableMissingCount += 1;
                if (stableMissingCount >= 3) return true;
            } else {
                stableMissingCount = 0;
            }
            await autoReviewSleep(100);
        }
        throw new Error('等待网站确认取消占有超时');
    }

    async function flmSkipCurrentOrder(button) {
        if (flmSkipRunning || autoReviewRunning) return;
        const currentOrderId = flmGetCurrentOrderId();
        const slot = flmReadPrefetchSlot();
        if (!currentOrderId) return;
        if (!slot || slot.state !== 'ready' || slot.sourceOrderId !== currentOrderId) {
            autoReviewToast('下一单尚未预取完成，请稍等后再跳过。', true);
            flmStartPrefetchForCurrentOrder();
            return;
        }

        const cancelButton = flmFindCancelOccupyButton();
        if (!cancelButton) {
            // 没有可用的“取消占有”通常表示当前订单本身无法继续操作。
            // 此时不阻塞用户，直接消费已经确认有效的单槽进入下一单。
            if (!flmConsumeReadySlot(currentOrderId, '未检测到可用的“取消占有”，已跳过当前订单')) {
                autoReviewToast('未找到“取消占有”，且预存订单已失效，请手动处理。', true);
            }
            return;
        }

        flmSkipRunning = true;
        if (button) {
            button.disabled = true;
            button.textContent = '正在释放...';
        }
        try {
            autoReviewToast('正在取消占有当前订单...');
            autoReviewClickEl(cancelButton);
            await flmConfirmCancelOccupyDialog();
            await flmWaitForCancelSuccess(currentOrderId, cancelButton);
            if (!flmConsumeReadySlot(currentOrderId, '当前订单已释放')) {
                autoReviewToast('当前订单已释放，但缓存订单已失效，请手动进入下一单。', true);
            }
        } catch (error) {
            console.error('[福临门跳过] 失败：', error);
            autoReviewToast('取消占有未确认成功，已停止跳转：' + error.message, true);
        } finally {
            flmSkipRunning = false;
            if (button && button.isConnected) {
                button.disabled = false;
                button.textContent = '⏭ 跳过此单';
            }
        }
    }

    function flmEnsureSkipButton() {
        if (!document.body || document.getElementById('sj-skip-order-btn')) return;
        const button = document.createElement('button');
        button.id = 'sj-skip-order-btn';
        button.type = 'button';
        button.textContent = '⏭ 跳过此单';
        button.title = '取消占有当前订单，并进入已预取的下一单';
        button.addEventListener('click', () => flmSkipCurrentOrder(button));
        document.body.appendChild(button);
    }

    // 右上角提示
    function autoReviewToast(msg, isError) {
        if (!document.body) return; // 安全防御：以防 body 尚未挂载
        if (!autoReviewToastEl) {
            autoReviewToastEl = document.createElement('div');
            autoReviewToastEl.style.position = 'fixed';
            autoReviewToastEl.style.top = '80px';
            autoReviewToastEl.style.right = '20px';
            autoReviewToastEl.style.zIndex = 999999;
            autoReviewToastEl.style.padding = '10px 16px';
            autoReviewToastEl.style.borderRadius = '6px';
            autoReviewToastEl.style.fontSize = '14px';
            autoReviewToastEl.style.color = '#fff';
            autoReviewToastEl.style.maxWidth = '320px';
            autoReviewToastEl.style.lineHeight = '1.4';
            autoReviewToastEl.style.boxShadow = '0 2px 8px rgba(0,0,0,.25)';
            document.body.appendChild(autoReviewToastEl);
        }
        autoReviewToastEl.style.background = isError ? '#f56c6c' : '#10b981';
        autoReviewToastEl.textContent = msg;
        autoReviewToastEl.style.display = 'block';
        clearTimeout(autoReviewToastEl._timer);
        autoReviewToastEl._timer = setTimeout(() => {
            autoReviewToastEl.style.display = 'none';
        }, 4000);
    }

    // ① 带执行锁的全流程审核入口（防并发）
    async function autoReviewRunFullFlow() {
        if (autoReviewRunning) {
            autoReviewToast('正在执行中，请稍候...', true);
            return;
        }
        autoReviewRunning = true;
        const btn = document.getElementById('sj-auto-review-btn');
        const btnText = btn ? btn.querySelector('.sj-btn-text') : null;

        // ② 按钮切换为加载态
        if (btn && btnText) {
            btn.disabled = true;
            btnText.textContent = '执行中...';
        }

        try {
            // ★ 先确保 Q22 第一个选项已选
            let selectedQ22 = false;
            const flowReviews = document.querySelectorAll('.answer--review');

            for (const review of flowReviews) {
                const cardInfo = findQuestionCard(review);

                if (cardInfo && cardInfo.qNum === 'Q22') {
                    const options = Array.from(
                        cardInfo.card.querySelectorAll('.question--option, .question-option')
                    );

                    console.log('[Q22] card:', cardInfo.card);
                    console.log('[Q22] 找到选项数量:', options.length, options);

                    if (options.length > 0) {
                        const opt1 = options[0];

                        opt1.scrollIntoView({ block: 'center', inline: 'nearest' });
                        await autoReviewSleep(100);

                        // 优先点标题文字，再点整行 (使用中心坐标点击法)
                        const title = opt1.querySelector('.option-title');
                        if (title) {
                            autoReviewClickCenter(title);
                        }

                        autoReviewClickCenter(opt1);

                        selectedQ22 = true;
                        console.log('[Q22] 已点击第一个选项');
                    } else {
                        console.warn('[Q22] 没找到选项，cardInfo.card 可能不是整张题卡');
                    }

                    break;
                }
            }

            if (selectedQ22) {
                await autoReviewSleep(500);
            }

            // ④ 检测是否所有题目已有判断，若已全判断则跳过通过步骤直接提交
            if (autoReviewAllJudged()) {
                autoReviewToast('所有题目已有判断，直接提交审核...');
            } else {
                autoReviewToast('开始执行：一键通过所有题目...');
                autoReviewPassAllQuestions();
                // ③ 去掉固定 300ms，弹窗轮询本身已能处理异步等待
            }

            const finishBtn = autoReviewGetFinishButton();
            if (!finishBtn) {
                autoReviewToast('未找到"审核完成"按钮（此单可能已审核过）', true);
                return;
            }
            autoReviewClickEl(finishBtn);

            // 等待确认弹窗（同步轮询，安全防护，最大重试次数以防死循环）
            let dialog = null;
            for (let i = 0; i < 35; i++) { // 35 * 150ms ≈ 5.2s
                dialog = autoReviewGetVisibleReviewDialog();
                if (dialog) break;
                await autoReviewSleep(150);
            }

            if (!dialog) {
                autoReviewToast('未出现确认弹窗，请检查页面是否有题目未审核完', true);
                return;
            }

            const hasRating = dialog.textContent.includes('打分标准') || dialog.querySelectorAll('.el-rate__item').length > 0;

            if (hasRating) {
                const radios = Array.from(dialog.querySelectorAll('.el-radio'));
                const fullRadio = radios.find((r) => r.textContent.includes('获得赏金的100%'));
                if (fullRadio && !fullRadio.classList.contains('is-checked')) {
                    autoReviewClickEl(fullRadio.querySelector('input') || fullRadio);
                    await autoReviewSleep(150);
                }

                const starsSelected = autoReviewClickHighestAvailableStar(dialog);
                if (starsSelected > 0) {
                    await autoReviewSleep(200);
                } else {
                    autoReviewToast('未找到可选的星级', true);
                }
            } else {
                autoReviewToast('检测到有题目被判定不通过，将直接确认提交...');
            }

            const confirmBtn = Array.from(dialog.querySelectorAll('button')).find(
                (b) => b.textContent.trim() === '确认'
            );
            if (!confirmBtn) {
                autoReviewToast('未找到确认按钮', true);
                return;
            }
            const submittedOrderId = flmGetCurrentOrderId();
            const fastJumpArmed = flmArmAuditPrefetchJump();
            autoReviewClickEl(confirmBtn);

            if (fastJumpArmed) {
                autoReviewToast('确认已点击，提交成功后直接进入预存下一单...');
            }

            // 通过和退回共用同一条快速路径：接口确认成功后直接消费预存槽。
            // 仅留出极短时间让网站自身的成功回调执行完，避免其随后把路由覆盖回原订单。
            let nextBtn = null;
            let serverConfirmed = false;
            for (let i = 0; i < 480; i++) { // 25ms 轮询，最长安全兜底 12 秒
                if (flmGetCurrentOrderId() !== submittedOrderId || flmPrefetchJumping) return;
                nextBtn = autoReviewGetNextOrderButton();
                const confirmation = flmAuditSubmitConfirmation;
                serverConfirmed = Boolean(confirmation &&
                    confirmation.currentOrderId === submittedOrderId &&
                    Date.now() - confirmation.confirmedAt >= 180);
                if (nextBtn || serverConfirmed) break;
                await autoReviewSleep(25);
            }

            nextBtn = autoReviewGetNextOrderButton();
            if (nextBtn || serverConfirmed) {
                flmAuditJumpArm = null;
                flmAuditSubmitConfirmation = null;
                if (!flmConsumeReadySlot(submittedOrderId,
                    serverConfirmed ? '审核接口已确认成功' : '审核成功弹窗已出现')) {
                    autoReviewToast('审核已提交，缓存订单不可用，改走网站原生下一单...');
                    if (nextBtn) autoReviewClickEl(nextBtn);
                }
            } else {
                flmAuditJumpArm = null;
                flmAuditSubmitConfirmation = null;
                autoReviewToast('12秒内未确认审核成功，插件没有盲目跳转，请检查网络或手动确认', true);
            }
        } catch (err) {
            console.error(err);
            autoReviewToast('执行出错: ' + err.message, true);
        } finally {
            // ① 无论成功失败，均释放锁并还原按钮
            autoReviewRunning = false;
            const restoredBtn = document.getElementById('sj-auto-review-btn');
            const restoredBtnText = restoredBtn ? restoredBtn.querySelector('.sj-btn-text') : null;
            if (restoredBtn && restoredBtnText) {
                restoredBtn.disabled = false;
                restoredBtnText.textContent = '一键通过审核';
            }
        }
    }

    // 创建悬浮控制面板
    function autoReviewCreatePanel() {
        if (!document.body || document.getElementById('sj-auto-review-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'sj-auto-review-btn';
        btn.innerHTML = `
            <svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>
            <span class="sj-btn-text">一键通过审核</span>
        `;
        btn.title = '快捷键 Alt+A [可左键拖动位置]';

        // 读取持久化位置坐标
        const savedX = localStorage.getItem('sj_auto_review_btn_x');
        const savedY = localStorage.getItem('sj_auto_review_btn_y');
        if (savedX && savedY) {
            btn.style.right = 'auto';
            btn.style.transform = 'none';
            btn.style.left = savedX + 'px';
            btn.style.top = savedY + 'px';
        }

        // 拖拽逻辑实现
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let initialLeft = 0;
        let initialTop = 0;

        btn.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // 仅限鼠标左键拖拽
            isDragging = false;
            startX = e.clientX;
            startY = e.clientY;

            const rect = btn.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;

            btn.classList.add('sj-dragging');
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            e.preventDefault(); // 阻止默认的文本拖选
        });

        const onMouseMove = (e) => {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            if (!isDragging && Math.sqrt(dx * dx + dy * dy) > 5) {
                isDragging = true;
            }

            if (isDragging) {
                let newLeft = initialLeft + dx;
                let newTop = initialTop + dy;

                const rect = btn.getBoundingClientRect();
                const btnWidth = rect.width;
                const btnHeight = rect.height;
                const maxLeft = window.innerWidth - btnWidth;
                const maxTop = window.innerHeight - btnHeight;

                newLeft = Math.max(0, Math.min(newLeft, maxLeft));
                newTop = Math.max(0, Math.min(newTop, maxTop));

                btn.style.right = 'auto';
                btn.style.transform = 'none';
                btn.style.left = newLeft + 'px';
                btn.style.top = newTop + 'px';
            }
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            btn.classList.remove('sj-dragging');

            if (isDragging) {
                const rect = btn.getBoundingClientRect();
                localStorage.setItem('sj_auto_review_btn_x', Math.round(rect.left));
                localStorage.setItem('sj_auto_review_btn_y', Math.round(rect.top));
            }
        };

        // ① 点击直接调用带锁的流程，锁与按钮状态已在 runFullFlow 内统一管理
        btn.addEventListener('click', (e) => {
            if (isDragging) {
                isDragging = false;
                return;
            }
            autoReviewRunFullFlow();
        });
        document.body.appendChild(btn);
        flmEnsureSkipButton();
    }

    function findQuestionCard(review) {
        let temp = review.parentElement;
        while (temp && temp !== document.body) {
            const titleEl = temp.querySelector('.answer-title, h4, h3, .el-form-item__label, .answer-question-title, [class*="title"], [class*="header"]');
            if (titleEl) {
                const match = titleEl.textContent.trim().match(/^[qQ](\d+)/);
                if (match) {
                    return {
                        card: temp,
                        qNum: 'Q' + match[1],
                        titleEl
                    };
                }
            }
            temp = temp.parentElement;
        }
        return null;
    }

    function getAllQuestionCards() {
        const cardsMap = {};
        const reviews = document.querySelectorAll('.answer--review');
        reviews.forEach(review => {
            const cardInfo = findQuestionCard(review);
            if (cardInfo) {
                cardsMap[cardInfo.qNum] = cardInfo.card;
            }
        });
        return cardsMap;
    }

    function findEvidenceContainer(card) {
        const titleEl = Array.from(card.querySelectorAll('*')).find(el => {
            if (el.children.length > 0) return false;
            return el.textContent.trim().includes('照片证据');
        });
        if (!titleEl) return null;

        let current = titleEl.parentElement;
        while (current && current !== card) {
            const uploadList = current.querySelector('.el-upload-list, [class*="upload-list"]');
            if (uploadList) return uploadList;

            const imgs = current.querySelectorAll('img');
            if (imgs.length > 0) {
                // Find the first ancestor of all images under current
                let parent = imgs[0].parentElement;
                while (parent && parent !== card) {
                    const allContained = Array.from(imgs).every(img => parent.contains(img));
                    if (allContained) {
                        break;
                    }
                    parent = parent.parentElement;
                }
                
                // If parent is just wrapping one image, go up one level to get the list container
                if (parent && parent.querySelectorAll('img').length === 1 && parent.parentElement && parent.parentElement !== card) {
                    return parent.parentElement;
                }
                return parent || imgs[0].parentElement;
            }
            current = current.parentElement;
        }
        return null;
    }

    function findReferenceContainer(card) {
        const titleEl = Array.from(card.querySelectorAll('*')).find(el => {
            if (el.children.length > 0) return false;
            return el.textContent.trim().includes('审核参考');
        });
        if (!titleEl) return null;

        let current = titleEl.parentElement;
        while (current && current !== card) {
            const refContent = current.querySelector('.ref-content, [class*="ref-"], [class*="reference"]');
            if (refContent) return refContent;

            const textElements = Array.from(current.querySelectorAll('*')).filter(el => el.children.length === 0 && el.textContent.trim() === '无');
            if (textElements.length > 0) {
                return textElements[0].parentElement || textElements[0];
            }
            
            const imgs = current.querySelectorAll('img');
            if (imgs.length > 0) {
                return imgs[0].parentElement;
            }
            
            current = current.parentElement;
        }
        return null;
    }

    function cloneQ5EvidenceToQ6() {
        return;

        // Count images
        const q5Imgs = q5Evidence.querySelectorAll('img');
        const q5ImgCount = q5Imgs.length;
        if (q5ImgCount === 0) return; // No images to copy yet

        const existingWrapper = q6Card.querySelector('.sj-cloned-wrapper');
        if (existingWrapper) {
            // Check if the image count matches. If it matches, no need to re-clone!
            const clonedImgCount = existingWrapper.querySelectorAll('img').length;
            if (q5ImgCount === clonedImgCount) {
                return;
            }
            // If they don't match, remove the old cloned wrapper so we can re-clone and update
            existingWrapper.remove();
        }

        // Read computed sizes of the original Q5 elements to match exactly
        const firstOriginalItem = q5Evidence.querySelector('.el-upload-list__item, [class*="item"]');
        let itemWidth = '', itemHeight = '';
        if (firstOriginalItem) {
            const style = window.getComputedStyle(firstOriginalItem);
            itemWidth = style.width;
            itemHeight = style.height;
        }

        const firstOriginalImg = q5Evidence.querySelector('img');
        let imgWidth = '', imgHeight = '';
        if (firstOriginalImg) {
            const style = window.getComputedStyle(firstOriginalImg);
            imgWidth = style.width;
            imgHeight = style.height;
        }

        // Clone Q5's evidence container
        const clonedEvidence = q5Evidence.cloneNode(true);
        clonedEvidence.classList.add('sj-cloned-q5-evidence');
        
        clonedEvidence.style.marginTop = '10px';
        clonedEvidence.style.border = '1px dashed rgba(16, 185, 129, 0.4)';
        clonedEvidence.style.borderRadius = '8px';
        clonedEvidence.style.padding = '8px';
        clonedEvidence.style.background = 'rgba(16, 185, 129, 0.03)';
        clonedEvidence.style.width = '100%';
        clonedEvidence.style.boxSizing = 'border-box';

        // Apply sizes to cloned items & images to override scoped reference styles
        clonedEvidence.querySelectorAll('.el-upload-list__item, [class*="item"]').forEach(item => {
            if (itemWidth) item.style.setProperty('width', itemWidth, 'important');
            if (itemHeight) item.style.setProperty('height', itemHeight, 'important');
        });

        clonedEvidence.querySelectorAll('img').forEach(img => {
            if (imgWidth) img.style.setProperty('width', imgWidth, 'important');
            if (imgHeight) img.style.setProperty('height', imgHeight, 'important');
            img.style.setProperty('object-fit', 'cover', 'important');
        });
        
        const plusBtn = clonedEvidence.querySelector('.el-upload, [class*="upload"]');
        if (plusBtn) plusBtn.remove();
        
        const originalImgs = Array.from(q5Evidence.querySelectorAll('img'));
        const clonedImgs = Array.from(clonedEvidence.querySelectorAll('img'));
        
        clonedImgs.forEach((clonedImg, index) => {
            const originalImg = originalImgs[index];
            if (originalImg) {
                const clickableParent = originalImg.closest('.el-upload-list__item, .el-image, div') || originalImg;
                
                // Click forwarding
                clonedImg.style.cursor = 'pointer';
                clonedImg.addEventListener('click', (e) => {
                    e.stopPropagation();
                    clickableParent.click();
                });
                
                const itemWrapper = clonedImg.closest('.el-upload-list__item, [class*="item"]');
                if (itemWrapper) {
                    itemWrapper.style.cursor = 'pointer';
                    itemWrapper.addEventListener('click', (e) => {
                        e.stopPropagation();
                        clickableParent.click();
                    });
                    
                    // Context menu (right-click) forwarding
                    itemWrapper.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        
                        const eventOpts = {
                            bubbles: true,
                            cancelable: true,
                            clientX: e.clientX,
                            clientY: e.clientY,
                            screenX: e.screenX,
                            screenY: e.screenY,
                            button: e.button,
                            buttons: e.buttons
                        };
                        const forwardedEvent = new MouseEvent('contextmenu', eventOpts);
                        clickableParent.dispatchEvent(forwardedEvent);
                    });
                } else {
                    // Context menu (right-click) forwarding for image direct tag
                    clonedImg.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        
                        const eventOpts = {
                            bubbles: true,
                            cancelable: true,
                            clientX: e.clientX,
                            clientY: e.clientY,
                            screenX: e.screenX,
                            screenY: e.screenY,
                            button: e.button,
                            buttons: e.buttons
                        };
                        const forwardedEvent = new MouseEvent('contextmenu', eventOpts);
                        clickableParent.dispatchEvent(forwardedEvent);
                    });
                }
            }
        });

        // Hide "无" text inside q6Reference to make space
        Array.from(q6Reference.childNodes).forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) {
                if (node.textContent.trim().includes('无')) {
                    node.textContent = '';
                }
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.textContent.trim() === '无') {
                    node.style.display = 'none';
                }
            }
        });

        // Also check if q6Reference is just a wrapper containing "无"
        if (q6Reference.textContent.trim() === '无') {
            q6Reference.innerHTML = '';
        }

        // Create a wrapper and align to top-left to avoid modifying q6Reference layout directly
        const wrapper = document.createElement('div');
        wrapper.className = 'sj-cloned-wrapper';
        wrapper.style.setProperty('width', '100%', 'important');
        wrapper.style.setProperty('text-align', 'left', 'important');
        wrapper.style.setProperty('display', 'block', 'important');
        wrapper.style.setProperty('box-sizing', 'border-box', 'important');
        wrapper.style.setProperty('padding', '12px', 'important');

        const refTitle = document.createElement('div');
        refTitle.className = 'sj-cloned-title';
        refTitle.textContent = 'Q5 照片证据参考:';
        refTitle.style.fontSize = '12px';
        refTitle.style.fontWeight = 'bold';
        refTitle.style.color = '#10b981';
        refTitle.style.marginBottom = '6px';
        refTitle.style.width = '100%';
        
        wrapper.appendChild(refTitle);
        wrapper.appendChild(clonedEvidence);
        q6Reference.appendChild(wrapper);
    }

    async function handleQ6QuickFail() {
        const cards = getAllQuestionCards();
        const q6Card = cards['Q6'];
        if (!q6Card) {
            autoReviewToast('未找到Q6题目卡片', true);
            return;
        }

        const q6Evidence = findEvidenceContainer(q6Card);
        if (!q6Evidence) {
            autoReviewToast('未找到Q6照片证据容器', true);
            return;
        }

        // 1. Detect annotated thumbnails
        const imgs = Array.from(q6Evidence.querySelectorAll('img'));
        if (imgs.length === 0) {
            autoReviewToast('Q6卡片中没有发现图片', true);
            return;
        }

        const annotatedIndices = [];
        imgs.forEach((img, index) => {
            // 1. Check if image URL contains "annotation" (the most reliable way)
            const src = img.src || '';
            if (src.includes('annotation')) {
                annotatedIndices.push(index + 1);
                return;
            }

            // 2. Fallback: check DOM elements/badges
            const wrapper = img.closest('li, .el-upload-list__item, .answer-file') || img.parentElement;
            
            const checkIcon = wrapper.querySelector('.el-upload-list__item-status-label, [class*="status-label"], .el-icon-check, [class*="icon-check"]');
            if (checkIcon) {
                const style = window.getComputedStyle(checkIcon);
                const rect = checkIcon.getBoundingClientRect();
                const isVisible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
                if (isVisible) {
                    annotatedIndices.push(index + 1);
                    return;
                }
            }

            const badge = wrapper.querySelector('.el-badge__content, [class*="badge__content"]');
            if (badge) {
                const style = window.getComputedStyle(badge);
                const rect = badge.getBoundingClientRect();
                const isVisible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
                if (isVisible) {
                    annotatedIndices.push(index + 1);
                    return;
                }
            }
        });

        // 2. Validation
        if (annotatedIndices.length === 0) {
            autoReviewToast('请先在图片中进行红框标注，再点击一键不通过！', true);
            return;
        }

        // 3. Generate reason text
        const getChineseOrdinal = (num) => {
            const map = {
                1: '第一张', 2: '第二张', 3: '第三张', 4: '第四张', 5: '第五张',
                6: '第六张', 7: '第七张', 8: '第八张', 9: '第九张', 10: '第十张'
            };
            return map[num] || `第${num}张`;
        };
        const photoRefs = annotatedIndices.map(getChineseOrdinal).join('，');
        const reason = `${photoRefs}照片标注处补拍规格`;

        // 4. Click native "不通过" button
        const nativeFailBtn = q6Card.querySelector('.answer--review .el-button--danger');
        if (!nativeFailBtn) {
            autoReviewToast('未找到原生的"不通过"按钮', true);
            return;
        }
        autoReviewClickEl(nativeFailBtn);

        // 5. Wait for the dialog
        let dialog = null;
        for (let i = 0; i < 30; i++) {
            dialog = Array.from(document.querySelectorAll('.el-dialog, .question-review-msg-box')).find(d => {
                const rect = d.getBoundingClientRect();
                const hasTextarea = d.querySelector('textarea, .el-textarea__inner') !== null;
                return rect.width > 0 && rect.height > 0 && hasTextarea;
            });
            if (dialog) break;
            await autoReviewSleep(100);
        }

        if (!dialog) {
            autoReviewToast('未检测到弹出的审核不通过对话框', true);
            return;
        }

        // 6. Fill the reason textarea
        const textarea = dialog.querySelector('textarea, .el-textarea__inner');
        if (!textarea) {
            autoReviewToast('未找到输入框，请手动填写原因', true);
            return;
        }

        textarea.value = reason;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        // 7. Auto-click the Confirm button to submit
        const confirmBtn = Array.from(dialog.querySelectorAll('button')).find(
            b => b.textContent.trim() === '确认' || b.textContent.trim() === '确定'
        );
        if (confirmBtn) {
            await autoReviewSleep(150);
            autoReviewClickEl(confirmBtn);
            autoReviewToast(`已快捷不通过并提交：${reason}`);
        } else {
            autoReviewToast('未找到"确认"按钮，请手动点击提交', true);
        }
    }

    function ensureQ6QuickFailButton() {
        return;

        const reviewDiv = q6Card.querySelector('.answer--review');
        if (!reviewDiv) return;

        const nativeFailBtn = reviewDiv.querySelector('.el-button--danger');
        if (!nativeFailBtn) return;

        let quickFailBtn = reviewDiv.querySelector('.sj-quick-fail-btn');
        if (!quickFailBtn) {
            quickFailBtn = document.createElement('button');
            // Remove el-button--danger to prevent querySelector('.el-button--danger') collision
            quickFailBtn.className = 'el-button is-plain sj-quick-fail-btn';
            quickFailBtn.type = 'button';
            quickFailBtn.style.marginLeft = '12px';
            quickFailBtn.style.padding = '10px 20px';
            quickFailBtn.style.fontSize = '14px';
            quickFailBtn.style.fontWeight = 'bold';
            quickFailBtn.textContent = '一键不通过';
            
            // Apply danger plain styles manually
            quickFailBtn.style.color = '#f56c6c';
            quickFailBtn.style.backgroundColor = '#fef0f0';
            quickFailBtn.style.borderColor = '#fbc4c4';
            quickFailBtn.style.transition = 'all 0.15s ease';

            quickFailBtn.addEventListener('mouseenter', () => {
                quickFailBtn.style.color = '#fff';
                quickFailBtn.style.backgroundColor = '#f56c6c';
                quickFailBtn.style.borderColor = '#f56c6c';
            });
            quickFailBtn.addEventListener('mouseleave', () => {
                quickFailBtn.style.color = '#f56c6c';
                quickFailBtn.style.backgroundColor = '#fef0f0';
                quickFailBtn.style.borderColor = '#fbc4c4';
            });
            
            quickFailBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await handleQ6QuickFail();
            });

            nativeFailBtn.parentNode.insertBefore(quickFailBtn, nativeFailBtn.nextSibling);
        }
    }

    // Q22 自动选第一个选项（每个新订单只执行一次）
    function selectQ22Opt1() {
        if (q22SelectedForCurrentOrder) return;

        const reviews = document.querySelectorAll('.answer--review');
        for (const review of reviews) {
            const cardInfo = findQuestionCard(review);
            if (!cardInfo || cardInfo.qNum !== 'Q22') continue;

            const optionsContainer = review.querySelector('.question-options');
            if (!optionsContainer) return;

            const options = optionsContainer.querySelectorAll('.question-option');
            if (options.length === 0) return;

            const opt1 = options[0];

            // 检查是否已经选中，避免重复点击
            const alreadySelected = opt1.classList.contains('checked') ||
                opt1.classList.contains('is-checked') ||
                opt1.classList.contains('active') ||
                !!opt1.querySelector('[class*="checked"], [class*="active"], [class*="selected"]');
            if (alreadySelected) {
                q22SelectedForCurrentOrder = true;
                return;
            }

            // 触发点击，兼容 Vue 双向绑定
            const opts = { bubbles: true, cancelable: true };
            opt1.dispatchEvent(new MouseEvent('mousedown', opts));
            opt1.dispatchEvent(new MouseEvent('mouseup', opts));
            opt1.dispatchEvent(new MouseEvent('click', opts));
            q22SelectedForCurrentOrder = true;
            return;
        }
    }

    // 初始化入口（每次由 init 定时检查，无额外并发定时器）
    function autoReviewCollapseUnneeded() {
        const collapseNums = new Set(['Q1', 'Q2', 'Q3', 'Q8', 'Q9', 'Q11', 'Q12', 'Q13', 'Q19', 'Q20', 'Q21']);
        const reviews = document.querySelectorAll('.answer--review');
        if (reviews.length === 0) return;

        reviews.forEach((review) => {
            const cardInfo = findQuestionCard(review);
            if (!cardInfo) return;

            const { card, qNum, titleEl } = cardInfo;
            const shouldCollapse = collapseNums.has(qNum) && !manuallyExpandedQuestions.has(qNum);

            if (!card.dataset.sjCollapseBound) {
                card.dataset.sjCollapseBound = 'true';
                card.addEventListener('click', (e) => {
                    const toggleBtn = card.querySelector('.sj-collapse-toggle-btn');
                    if (card.classList.contains('sj-collapsed-card')) {
                        card.classList.remove('sj-collapsed-card');
                        manuallyExpandedQuestions.add(qNum);
                        if (toggleBtn) toggleBtn.textContent = ' 收起';
                        e.stopPropagation();
                        e.preventDefault();
                    } else if (e.target.classList.contains('sj-collapse-toggle-btn')) {
                        card.classList.add('sj-collapsed-card');
                        manuallyExpandedQuestions.delete(qNum);
                        if (toggleBtn) toggleBtn.textContent = ' 展开';
                        e.stopPropagation();
                        e.preventDefault();
                    }
                });
            }

            let toggleBtn = card.querySelector('.sj-collapse-toggle-btn');
            if (collapseNums.has(qNum) && !toggleBtn) {
                toggleBtn = document.createElement('span');
                toggleBtn.className = 'sj-collapse-toggle-btn';
                toggleBtn.style.color = '#409EFF';
                toggleBtn.style.cursor = 'pointer';
                toggleBtn.style.marginLeft = '10px';
                toggleBtn.style.fontWeight = 'bold';
                toggleBtn.style.fontSize = '12px';
                titleEl.appendChild(toggleBtn);
            }

            if (shouldCollapse) {
                card.classList.add('sj-collapsed-card');
                if (toggleBtn) toggleBtn.textContent = ' 展开';
            } else {
                card.classList.remove('sj-collapsed-card');
                if (toggleBtn) toggleBtn.textContent = collapseNums.has(qNum) ? ' 收起' : '';
            }
        });
    }

    function autoReviewInit() {
        if (!location.pathname.startsWith('/order/review')) {
            reviewLastLocationHref = null;
            manuallyExpandedQuestions.clear();
            photoEditEnsureShortcutButton();
            const btn = document.getElementById('sj-auto-review-btn');
            if (btn) btn.remove();
            const skipBtn = document.getElementById('sj-skip-order-btn');
            if (skipBtn) skipBtn.remove();
            return;
        }
        photoEditEnsureShortcutButton();

        // 直接同步检测题目面板是否存在且一键通过按钮尚未渲染，满足才创建
            if (reviewLastLocationHref !== location.href) {
                reviewLastLocationHref = location.href;
                manuallyExpandedQuestions.clear();
                q22SelectedForCurrentOrder = false;
                auditHelperVerifiedQ13Options.clear();
            }
        if (document.querySelector('.answer--review')) {
            if (!document.getElementById('sj-auto-review-btn')) {
                autoReviewCreatePanel();
            }
            flmEnsureSkipButton();
            flmStartPrefetchForCurrentOrder();
            autoReviewCollapseUnneeded();
            cloneQ5EvidenceToQ6();
            ensureQ6QuickFailButton();
        }
    }

    // 初始化按钮与面板
    const init = () => {
        if (typeof autoReviewInit === 'function') {
            autoReviewInit();
        }
        if (typeof auditHelperUpdateWorkspace === 'function') {
            auditHelperUpdateWorkspace();
        }

        if (document.getElementById('sj-stats-float-btn')) return;

        // 创建悬浮球/HUD
        const btn = document.createElement('div');
        btn.id = 'sj-stats-float-btn';
        btn.title = '审核数据统计助手 (Alt + S) [双击展开/折叠迷你状态栏]';

        const initialMode = localStorage.getItem('sj_stats_hud_mode') || 'min';
        btn.className = initialMode === 'exp' ? 'sj-hud-exp' : 'sj-hud-min';

        if (initialMode === 'exp') {
            btn.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px; width: 100%; height: 100%; justify-content: center; font-family: 'Plus Jakarta Sans', sans-serif; opacity: 0.5;">
                    <svg viewBox="0 0 24 24" style="width: 15px; height: 15px; fill: currentColor; flex-shrink: 0; margin-top: 1px;">
                        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/>
                    </svg>
                    <span class="sj-hud-text" style="font-size: 11.5px; white-space: nowrap;">数据加载中...</span>
                </div>
            `;
        } else {
            btn.innerHTML = `
                <svg viewBox="0 0 24 24">
                    <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/>
                </svg>
                <div id="sj-stats-badge"></div>
            `;
        }

        // 读取持久化位置坐标
        const savedX = localStorage.getItem('sj_stats_btn_x');
        const savedY = localStorage.getItem('sj_stats_btn_y');
        if (savedX && savedY) {
            btn.style.right = 'auto';
            btn.style.bottom = 'auto';
            btn.style.left = savedX + 'px';
            btn.style.top = savedY + 'px';
        }

        document.body.appendChild(btn);
        initFloatBadge();

        // 拖拽逻辑实现 (v2.4)
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let initialLeft = 0;
        let initialTop = 0;

        btn.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // 仅限鼠标左键拖拽
            isDragging = false;
            startX = e.clientX;
            startY = e.clientY;

            const rect = btn.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;

            btn.classList.add('sj-dragging');
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            e.preventDefault(); // 阻止默认的文本拖选
        });

        const onMouseMove = (e) => {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            if (!isDragging && Math.sqrt(dx * dx + dy * dy) > 5) {
                isDragging = true;
            }

            if (isDragging) {
                let newLeft = initialLeft + dx;
                let newTop = initialTop + dy;

                const rect = btn.getBoundingClientRect();
                const btnWidth = rect.width;
                const btnHeight = rect.height;
                const maxLeft = window.innerWidth - btnWidth;
                const maxTop = window.innerHeight - btnHeight;

                newLeft = Math.max(0, Math.min(newLeft, maxLeft));
                newTop = Math.max(0, Math.min(newTop, maxTop));

                btn.style.right = 'auto';
                btn.style.bottom = 'auto';
                btn.style.left = newLeft + 'px';
                btn.style.top = newTop + 'px';
            }
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            btn.classList.remove('sj-dragging');

            if (isDragging) {
                const rect = btn.getBoundingClientRect();
                localStorage.setItem('sj_stats_btn_x', Math.round(rect.left));
                localStorage.setItem('sj_stats_btn_y', Math.round(rect.top));
            }
        };

        // 创建模态框
        const overlay = document.createElement('div');
        overlay.id = 'sj-stats-modal-overlay';
        overlay.innerHTML = `
            <div id="sj-stats-card">
                <div class="sj-card-header">
                    <h3 class="sj-card-title" style="display: flex; align-items: center; gap: 8px;">
                        <svg viewBox="0 0 24 24" style="width: 18px; height: 18px; fill: none; stroke: url(#sj-title-grad); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round;"><defs><linearGradient id="sj-title-grad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#3b82f6"/></linearGradient></defs><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="9" x2="15" y2="9"></line><line x1="9" y1="13" x2="15" y2="13"></line><line x1="9" y1="17" x2="13" y2="17"></line></svg>
                        审核效率统计助手
                    </h3>
                    <button class="sj-card-close" id="sj-stats-close-btn">
                        <svg viewBox="0 0 24 24">
                            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                        </svg>
                    </button>
                </div>
                <!-- 日期切换栏 -->
                <div class="sj-date-picker-bar">
                    <button class="sj-date-btn" id="sj-date-prev">
                        <svg viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        前一天
                    </button>
                    <input type="date" class="sj-date-input" id="sj-date-select">
                    <button class="sj-date-btn" id="sj-date-next">
                        后一天
                        <svg viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                    </button>
                    <button class="sj-date-btn" id="sj-refresh-btn" title="刷新当前数据" style="margin-left: auto; border-color: rgba(255, 255, 255, 0.15); color: #cbd5e1;">
                        <svg viewBox="0 0 24 24" style="width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:2.5; stroke-linecap:round; stroke-linejoin:round; margin-right:4px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                        刷新
                    </button>
                    <button class="sj-date-btn" id="sj-export-csv" title="导出数据为CSV" style="border-color: rgba(59, 130, 246, 0.25); color: #60a5fa;">
                        <svg viewBox="0 0 24 24" style="width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:2.5; stroke-linecap:round; stroke-linejoin:round; margin-right:4px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                        导出数据
                    </button>
                </div>
                <!-- 选项卡切换 (v1.8新增企业级设计) -->
                <div class="sj-tabs-header" style="display: flex; gap: 24px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); padding: 0 24px; background: rgba(255, 255, 255, 0.005); height: 40px; align-items: center;">
                    <div class="sj-tab-item active" id="sj-tab-daily">日效能分析</div>
                    <div class="sj-tab-item" id="sj-tab-weekly">近7日趋势</div>
                </div>
                <div class="sj-card-body" id="sj-stats-content">
                    <!-- 动态加载内容 -->
                </div>
                <!-- 键盘快捷键指示底部 (v2.2新增) -->
                <div class="sj-card-footer" style="padding: 10px 24px; border-top: 1px solid rgba(255, 255, 255, 0.04); background: rgba(0, 0, 0, 0.2); font-size: 11px; color: #475569; display: flex; justify-content: space-between; align-items: center; user-select: none;">
                    <span>提示：按 <kbd style="background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 3px; padding: 1px 4px; font-family: inherit; font-size: 10px; color: #94a3b8;">Alt + S</kbd> 可快速开关此面板</span>
                    <span>按 <kbd style="background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 3px; padding: 1px 4px; font-family: inherit; font-size: 10px; color: #94a3b8;">Esc</kbd> 退出或取消目标编辑</span>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        // 初始化日期控件值
        const dateInput = document.getElementById('sj-date-select');
        dateInput.value = formatDate(currentDate);
        dateInput.max = formatDate(new Date());

        const closePanel = () => {
            overlay.classList.remove('active');
            stopAutoRefresh();
        };

        // 事件绑定
        // 事件绑定 (v2.8支持单双击分离)
        let clickTimeout = null;
        btn.addEventListener('click', (e) => {
            if (isDragging) {
                isDragging = false; // 重置拖动状态
                if (clickTimeout) {
                    clearTimeout(clickTimeout);
                    clickTimeout = null;
                }
                return;
            }
            if (clickTimeout) {
                clearTimeout(clickTimeout);
                clickTimeout = null;
                return; // 捕获到双击，放弃此次点击触发
            }
            clickTimeout = setTimeout(() => {
                clickTimeout = null;
                overlay.classList.add('active');
                loadStats();
                startAutoRefresh();
            }, 220); // 220ms延时以区分双击
        });

        btn.addEventListener('dblclick', (e) => {
            if (clickTimeout) {
                clearTimeout(clickTimeout);
                clickTimeout = null;
            }
            toggleHudMode();
        });
        document.getElementById('sj-stats-close-btn').addEventListener('click', closePanel);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closePanel();
            }
        });
        // 键盘快捷键监听
        document.addEventListener('keydown', (e) => {
            // Esc 键关闭面板
            if (e.key === 'Escape' || e.key === 'Esc') {
                if (overlay.classList.contains('active')) {
                    closePanel();
                }
            }
            if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
                const tagName = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
                const isTyping = ['input', 'textarea', 'select'].includes(tagName) || (document.activeElement && document.activeElement.isContentEditable);
                if (!isTyping && photoEditGetDialog() && photoEditFindButtonByTitle('\u4fdd\u5b58')) {
                    e.preventDefault();
                    e.stopPropagation();
                    photoEditSaveAndConfirm();
                }
            }
            // Alt + S 组合键开关面板
            if (e.altKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) {
                e.preventDefault();
                if (overlay.classList.contains('active')) {
                    closePanel();
                } else {
                    overlay.classList.add('active');
                    loadStats();
                    startAutoRefresh();
                }
            }
            // Alt + A 组合键一键通过审核
            if (e.altKey && (e.key === 'a' || e.key === 'A' || e.code === 'KeyA')) {
                if (location.pathname.startsWith('/order/review')) {
                    e.preventDefault();
                    if (typeof autoReviewRunFullFlow === 'function') {
                        autoReviewRunFullFlow();
                    }
                }
            }
        });

        // 页面可见性监听 (自动挂起后台轮询以节约网络开销和避免拉黑)
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopAutoRefresh();
            } else if (overlay.classList.contains('active')) {
                startAutoRefresh();
                // 重新可见且面板是打开的，立即拉取一次今日最新数据进行重绘
                const token = localStorage.getItem('token');
                const dateStr = formatDate(currentDate);
                const todayStr = formatDate(new Date());
                if (token && currentTab === 'daily' && dateStr === todayStr) {
                    delete queryCache[dateStr];
                    fetchRecordsForDate(token, dateStr).then(allRecords => {
                        const yestDate = new Date(currentDate);
                        yestDate.setDate(yestDate.getDate() - 1);
                        return fetchRecordsForDate(token, formatDate(yestDate)).then(yesterdayRecords => {
                            const activeOverlay = document.getElementById('sj-stats-modal-overlay');
                            if (activeOverlay && activeOverlay.classList.contains('active')) {
                                renderStats(allRecords, yesterdayRecords);
                            }
                        });
                    }).catch(err => console.warn("Visibility resume refresh failed:", err));
                }
            }
        });

        // 日期切换事件
        document.getElementById('sj-date-prev').addEventListener('click', () => {
            currentDate.setDate(currentDate.getDate() - 1);
            updateDateUI();
            loadStats();
        });
        document.getElementById('sj-date-next').addEventListener('click', () => {
            const today = new Date();
            if (formatDate(currentDate) === formatDate(today)) return;
            currentDate.setDate(currentDate.getDate() + 1);
            updateDateUI();
            loadStats();
        });
        dateInput.addEventListener('change', (e) => {
            const selectedDate = new Date(e.target.value);
            if (!isNaN(selectedDate.getTime())) {
                currentDate = selectedDate;
                updateDateUI();
                loadStats();
            }
        });

        // 选项卡切换事件绑定
        const tabDaily = document.getElementById('sj-tab-daily');
        const tabWeekly = document.getElementById('sj-tab-weekly');

        tabDaily.addEventListener('click', () => {
            if (currentTab === 'daily') return;
            currentTab = 'daily';
            tabDaily.className = 'sj-tab-item active';
            tabWeekly.className = 'sj-tab-item';
            loadStats();
        });

        tabWeekly.addEventListener('click', () => {
            if (currentTab === 'weekly') return;
            currentTab = 'weekly';
            tabWeekly.className = 'sj-tab-item active';
            tabDaily.className = 'sj-tab-item';
            loadStats();
        });

        // 绑定刷新事件
        const refreshBtn = document.getElementById('sj-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                if (currentTab === 'daily') {
                    const dateStr = formatDate(currentDate);
                    delete queryCache[dateStr];
                    sessionStorage.removeItem(`sj_cache_records_${dateStr}`);
                    // 也删除昨天的缓存，以便重新获取昨日对照
                    const yestDate = new Date(currentDate);
                    yestDate.setDate(yestDate.getDate() - 1);
                    const yestDateStr = formatDate(yestDate);
                    delete queryCache[yestDateStr];
                    sessionStorage.removeItem(`sj_cache_records_${yestDateStr}`);
                } else {
                    const todayObj = new Date(currentDate);
                    for (let i = 0; i < 7; i++) {
                        const d = new Date(todayObj);
                        d.setDate(todayObj.getDate() - i);
                        const dStr = formatDate(d);
                        delete queryCache[dStr];
                        sessionStorage.removeItem(`sj_cache_records_${dStr}`);
                    }
                }
                loadStats();
            });
        }

        // 绑定数据导出事件 (支持分视图导出)
        const exportBtn = document.getElementById('sj-export-csv');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                if (currentTab === 'daily') {
                    if (!currentDayStats) {
                        alert("暂无当前日期的数据可导出！");
                        return;
                    }
                    const { dateStr, hourlyStats, hourlyReworkStats, totalCount, totalRework, totalAudits, speedPerHour, activeHours, observedCount, rejectedCount } = currentDayStats;
                    const target = getTargetForDate(dateStr);
                    const displayHours = [9, 10, 11, 13, 14, 15, 16, 17];

                    let csvContent = "\ufeff时间段,初审数量 (单),复审数量 (单),时间段备注\n";
                    displayHours.forEach(hour => {
                        let timeLabel = `${hour}-${hour + 1}点`;
                        let remark = "";
                        if (hour === 9) remark = "包含8点提前量";
                        if (hour === 11) remark = "包含12点午休量";
                        if (hour === 17) remark = "包含18点加班量";
                        csvContent += `"${timeLabel}","${hourlyStats[hour] || 0}","${hourlyReworkStats[hour] || 0}","${remark}"\n`;
                    });

                    csvContent += `"\n指标项目 (含单位)","指标数值"\n`;
                    csvContent += `"今日初审总量 (单)","${totalCount}"\n`;
                    csvContent += `"今日复审总量 (单)","${totalRework}"\n`;
                    csvContent += `"今日总审核量 (包含复审) (单)","${totalAudits}"\n`;
                    csvContent += `"今日退单 (单)","${rejectedCount || 0}"\n`;
                    csvContent += `"历史观测最大总量 (单)","${observedCount || totalAudits}"\n`;
                    csvContent += `"预设目标 (单)","${target}"\n`;
                    csvContent += `"目标达成率 (%)","${(totalCount / target * 100).toFixed(1)}"\n`;
                    csvContent += `"工作均速 (初审) (单/h)","${speedPerHour}"\n`;
                    csvContent += `"活跃工时 (小时)","${Number(activeHours).toFixed(1)}"\n`;

                    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.setAttribute("href", url);
                    link.setAttribute("download", `爱零工审核数据_${dateStr}.csv`);
                    link.style.visibility = 'hidden';
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                } else {
                    if (!currentWeeklyStats) {
                        alert("暂无可用周数据导出！");
                        return;
                    }
                    const { dateList, weeklyData, totalWeeklyFirst, totalWeeklyRework, totalWeeklyAudits, weeklyAvgSpeed, totalWeeklyActiveHours, goalMetDays, weeklyRecords } = currentWeeklyStats;
                    let csvContent = "\ufeff日期,初审数量 (单),复审数量 (单),总审核量 (单),退单数量 (单),活跃工时 (小时),初审均速 (单/h),是否达标\n";
                    dateList.forEach(dStr => {
                        const dayInfo = weeklyData[dStr];
                        const daySpeed = dayInfo.activeHours > 0 ? (dayInfo.firstRound / dayInfo.activeHours).toFixed(1) : '0.0';
                        const dayTarget = getTargetForDate(dStr);
                        const isGoalMet = dayInfo.firstRound >= dayTarget;

                        const dayRecords = (weeklyRecords || []).filter(item => item.reviewedtime && item.reviewedtime.startsWith(dStr));
                        const currentIds = dayRecords.map(item => item.id || item.reviewedtime);
                        let observedIds = getObservedIdsForDate(dStr);

                        const legacyMax = getMaxObservedForDate(dStr);
                        if (observedIds.length === 0 && legacyMax > currentIds.length) {
                            observedIds = [...currentIds];
                            const diff = legacyMax - currentIds.length;
                            for (let i = 0; i < diff; i++) {
                                observedIds.push(`legacy-rejected-dummy-${i}`);
                            }
                            setObservedIdsForDate(dStr, observedIds);
                        }

                        const newIds = currentIds.filter(id => !observedIds.includes(id));
                        if (newIds.length > 0) {
                            observedIds = [...observedIds, ...newIds];
                            setObservedIdsForDate(dStr, observedIds);
                        }

                        const missingIds = observedIds.filter(id => !currentIds.includes(id));
                        const rejectedCount = missingIds.length;
                        csvContent += `"${dStr}","${dayInfo.firstRound}","${dayInfo.rework}","${dayInfo.total}","${rejectedCount}","${dayInfo.activeHours}","${daySpeed}","${isGoalMet ? '是' : '否'}"\n`;
                    });

                    csvContent += `"\n指标项目 (含单位)","指标数值"\n`;
                    csvContent += `"7日初审总量 (单)","${totalWeeklyFirst}"\n`;
                    csvContent += `"7日复审总量 (单)","${totalWeeklyRework}"\n`;
                    csvContent += `"7日总审核量 (单)","${totalWeeklyAudits}"\n`;
                    csvContent += `"周均初审时速 (单/h)","${weeklyAvgSpeed}"\n`;
                    csvContent += `"周总工时 (小时)","${totalWeeklyActiveHours}"\n`;
                    csvContent += `"达标天数 (天)","${goalMetDays}"\n`;

                    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.setAttribute("href", url);
                    link.setAttribute("download", `爱零工周效能报表_${dateList[0]}_至_${dateList[6]}.csv`);
                    link.style.visibility = 'hidden';
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                }
            });
        }
    };

        const updateDateUI = () => {
        const dateInput = document.getElementById('sj-date-select');
        dateInput.value = formatDate(currentDate);

        const nextBtn = document.getElementById('sj-date-next');
        const todayStr = formatDate(new Date());
        const selectedStr = formatDate(currentDate);
        nextBtn.disabled = (selectedStr === todayStr);
    };

    const formatDate = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    const calculateActiveTime = (records, dateStr) => {
        const dayRecords = records.filter(item => item.reviewedtime && item.reviewedtime.startsWith(dateStr));
        if (dayRecords.length === 0) {
            return {
                totalActiveHours: 0,
                hourlyActiveHours: Array.from({ length: 24 }, () => 0)
            };
        }

        const hourlyActiveHours = Array.from({ length: 24 }, () => 0);
        const hourlyGroups = Array.from({ length: 24 }, () => []);

        dayRecords.forEach(item => {
            if (item.reviewedtime) {
                let hour = parseInt(item.reviewedtime.substring(11, 13), 10);
                if (!isNaN(hour)) {
                    if (hour === 8) hour = 9;
                    else if (hour === 12) hour = 11;
                    else if (hour === 18) hour = 17;
                    if (hour >= 0 && hour < 24) {
                        hourlyGroups[hour].push(item);
                    }
                }
            }
        });

        for (let h = 0; h < 24; h++) {
            const group = hourlyGroups[h];
            if (group.length === 0) {
                hourlyActiveHours[h] = 0;
                continue;
            }

            const times = group
                .map(item => Date.parse(item.reviewedtime.replace(/-/g, '/')))
                .filter(t => !isNaN(t));

            if (times.length === 0) {
                hourlyActiveHours[h] = 0;
                continue;
            }

            const minTime = Math.min(...times);
            const maxTime = Math.max(...times);
            let diffMs = maxTime - minTime;

            // 限制最少计入 2 分钟，防止分母过小造成时速极高
            const minDurationMs = 2 * 60 * 1000;
            if (diffMs < minDurationMs) {
                diffMs = minDurationMs;
            }

            hourlyActiveHours[h] = diffMs / (1000 * 3600);
        }

        const totalActiveHours = hourlyActiveHours.reduce((sum, h) => sum + h, 0);

        return {
            totalActiveHours,
            hourlyActiveHours
        };
    };

    // 判断日期范围是否包含今天
    const isTodayRange = (endTime) => {
        const todayStr = formatDate(new Date());
        return endTime.startsWith(todayStr);
    };

    // 发起查询并进行统计 (支持按标签页和内存缓存加载)
    const loadStats = async () => {
        if (chartInstance) {
            chartInstance.dispose();
            chartInstance = null;
        }

        const content = document.getElementById('sj-stats-content');
        content.innerHTML = `
            <div class="sj-loading-overlay">
                <div class="sj-spinner"></div>
                <div id="sj-loading-text" style="color: #64748b; font-size: 13px; font-weight: 500;">正在获取数据并加载渲染，请稍候...</div>
            </div>
        `;

        const token = localStorage.getItem('token');
        if (!token) {
            content.innerHTML = `<div style="text-align: center; color: #ef4444; padding: 20px;">未获取到登录Token，请重新刷新网页或重新登录！</div>`;
            return;
        }

        if (currentTab === 'daily') {
            const dateStr = formatDate(currentDate);
            const yestDate = new Date(currentDate);
            yestDate.setDate(yestDate.getDate() - 1);
            const yestDateStr = formatDate(yestDate);

            try {
                // 1. 加载今日数据
                const allRecords = await fetchRecordsForDate(token, dateStr, (loaded, total) => {
                    const loader = document.getElementById('sj-loading-text');
                    if (loader) {
                        loader.innerText = `今日数据拉取中... 已加载 ${loaded} / ${total} 条`;
                    }
                });

                // 2. 加载昨日数据（作为同期对照，默默拉取，出错不阻断主流程）
                let yesterdayRecords = [];
                try {
                    const loader = document.getElementById('sj-loading-text');
                    if (loader) {
                        loader.innerText = `正在读取昨日同期数据作为对照...`;
                    }
                    yesterdayRecords = await fetchRecordsForDate(token, yestDateStr);
                } catch (err) {
                    console.warn("Failed to fetch yesterday's reference data:", err);
                }

                renderStats(allRecords, yesterdayRecords);
            } catch (error) {
                console.error('Error fetching statistics:', error);
                content.innerHTML = `<div style="text-align: center; color: #ef4444; padding: 20px;">日效能数据拉取失败，这可能是由于接口限频或登录已过期。</div>`;
            }
        } else {
            // 周趋势
            const dateList = [];
            const todayObj = new Date(currentDate);
            for (let i = 6; i >= 0; i--) {
                const d = new Date(todayObj);
                d.setDate(todayObj.getDate() - i);
                dateList.push(formatDate(d));
            }

            try {
                const allRecords = [];
                for (let i = 0; i < dateList.length; i++) {
                    const dStr = dateList[i];
                    const loader = document.getElementById('sj-loading-text');
                    if (loader) {
                        loader.innerText = `正在拉取周效能数据... (${i + 1}/7) [${dStr.substring(5)}]`;
                    }
                    const dayRecords = await fetchRecordsForDate(token, dStr);
                    allRecords.push(...dayRecords);
                }
                renderWeeklyStats(allRecords);
            } catch (error) {
                console.error('Error fetching weekly statistics:', error);
                content.innerHTML = `<div style="text-align: center; color: #ef4444; padding: 20px;">周效能数据拉取失败，这可能是由于接口限频或登录已过期。</div>`;
            }
        }
    };

    // 获取单日数据，支持按日期做内存缓存与 sessionStorage 缓存，避免重复加载历史数据 (v2.2)
    const fetchRecordsForDate = async (token, dateStr, onProgress) => {
        const todayStr = formatDate(new Date());
        const canCache = (dateStr !== todayStr); // 今天的订单属于变动状态，不进行持久缓存

        if (canCache) {
            // 1. 尝试从内存缓存中读取
            if (queryCache[dateStr]) {
                if (onProgress) {
                    onProgress(queryCache[dateStr].length, queryCache[dateStr].length);
                }
                return queryCache[dateStr];
            }
            // 2. 尝试从 sessionStorage 跨页持久化中读取
            try {
                const sessionCached = sessionStorage.getItem(`sj_cache_records_v3.6_${dateStr}`);
                if (sessionCached) {
                    const parsed = JSON.parse(sessionCached);
                    queryCache[dateStr] = parsed;
                    if (onProgress) {
                        onProgress(parsed.length, parsed.length);
                    }
                    return parsed;
                }
            } catch (e) {
                console.warn("Failed to parse sessionStorage cache:", e);
            }
        }

        const startTime = `${dateStr} 00:00:00`;
        const endTime = `${dateStr} 23:59:59`;

        let page = 1;
        const perPage = 100;
        let allData = [];
        let hasMore = true;

        while (hasMore) {
            const response = await fetch('https://order-audit-api.slicejobs.com/admin/audit_task/query', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json;charset=UTF-8',
                    'sj-auth-token': token
                },
                body: JSON.stringify({
                    status: 2,
                    reviewedtime: [startTime, endTime],
                    current_page: page,
                    per_page: perPage
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP: ${response.status}`);
            }

            const resData = await response.json();
            if (resData.ret !== 0) {
                throw new Error(resData.msg || 'Error');
            }

            const dataList = resData.detail.data || [];
            allData = allData.concat(dataList);

            const total = resData.detail.total || 0;

            if (onProgress) {
                onProgress(allData.length, total);
            }

            if (allData.length >= total || dataList.length < perPage) {
                hasMore = false;
            } else {
                page++;
            }
        }

        if (canCache) {
            queryCache[dateStr] = allData;
            try {
                // 持久化 id, reviewedtime, review 属性，节约体积的同时保留唯一工单标识，防止溢出 5MB 的 sessionStorage 限制
                const minimalData = allData.map(item => ({
                    id: item.id || item.orderid || item.taskid || item.reviewedtime,
                    reviewedtime: item.reviewedtime,
                    review: item.review
                }));
                sessionStorage.setItem(`sj_cache_records_v3.6_${dateStr}`, JSON.stringify(minimalData));
            } catch (e) {
                console.warn("Failed to write sessionStorage cache:", e);
            }
        }

        return allData;
    };

    // 渲染日分析页面
    const renderStats = (records, yesterdayRecords = []) => {
        // 执行自愈自净化，消除跨天合并数据造成的 ID 污染
        sanitizeAllObservedIds([...records, ...yesterdayRecords]);

        const hourlyStats = Array.from({ length: 24 }, () => 0);
        const hourlyReworkStats = Array.from({ length: 24 }, () => 0);
        const yesterdayHourlyStats = Array.from({ length: 24 }, () => 0);
        const yesterdayHourlyReworkStats = Array.from({ length: 24 }, () => 0);

        records.forEach(item => {
            if (item.reviewedtime) {
                let hour = parseInt(item.reviewedtime.substring(11, 13), 10);
                if (!isNaN(hour)) {
                    // 应用合并规则 (12-13点午休数据全部归并入11-12点)
                    if (hour === 8) {
                        hour = 9;  // 8-9点合并进9点
                    } else if (hour === 12) {
                        hour = 11; // 12-13点午休全部合并入11点段
                    } else if (hour === 18) {
                        hour = 17; // 18-19点合并进17点
                    }

                    if (hour >= 0 && hour < 24) {
                        if (isFirstRoundAudit(item)) {
                            hourlyStats[hour]++;
                        } else {
                            hourlyReworkStats[hour]++;
                        }
                    }
                }
            }
        });

        yesterdayRecords.forEach(item => {
            if (item.reviewedtime) {
                let hour = parseInt(item.reviewedtime.substring(11, 13), 10);
                if (!isNaN(hour)) {
                    if (hour === 8) {
                        hour = 9;
                    } else if (hour === 12) {
                        hour = 11;
                    } else if (hour === 18) {
                        hour = 17;
                    }

                    if (hour >= 0 && hour < 24) {
                        if (isFirstRoundAudit(item)) {
                            yesterdayHourlyStats[hour]++;
                        } else {
                            yesterdayHourlyReworkStats[hour]++;
                        }
                    }
                }
            }
        });

        const selectedDateStr = formatDate(currentDate);
        const isToday = (selectedDateStr === formatDate(new Date()));
        const nowHour = new Date().getHours();
        const nowMin = new Date().getMinutes();

        // 核心展示时段（跳过12点午休，合计8个显示时段）
        const displayHours = [9, 10, 11, 13, 14, 15, 16, 17];
        let totalFirst = 0;
        let totalRework = 0;
        let activeHours = 0;

        // 统计全天所有24小时的总初审和总复审量，防止遗漏排班时段外的加班审核 (v3.6.2)
        for (let h = 0; h < 24; h++) {
            totalFirst += hourlyStats[h];
            totalRework += hourlyReworkStats[h];
        }

        const activeInfo = calculateActiveTime(records, selectedDateStr);
        displayHours.forEach(h => {
            if (hourlyStats[h] > 0 || hourlyReworkStats[h] > 0) {
                activeHours += activeInfo.hourlyActiveHours[h] || 0;
            }
        });

        const totalAudits = totalFirst + totalRework;
        const speedPerHour = activeHours > 0 ? (totalFirst / activeHours).toFixed(1) : '0.0';
        const totalSpeedPerHour = activeHours > 0 ? (totalAudits / activeHours).toFixed(1) : '0.0';
        const standardSpeed = (totalFirst / 8).toFixed(1);

        // 每日已观测审核工单 ID 集合管理 (v3.5, v3.6.1 过滤以防跨天合并带来的 ID 交叉污染)
        const dayRecordsForObserved = records.filter(item => item.reviewedtime && item.reviewedtime.startsWith(selectedDateStr));
        const currentIds = dayRecordsForObserved.map(item => item.id || item.orderid || item.taskid || item.reviewedtime);
        let observedIds = getObservedIdsForDate(selectedDateStr);

        // 兼容 v3.4 升级
        const legacyMax = getMaxObservedForDate(selectedDateStr);
        if (observedIds.length === 0 && legacyMax > currentIds.length) {
            observedIds = [...currentIds];
            const diff = legacyMax - currentIds.length;
            for (let i = 0; i < diff; i++) {
                observedIds.push(`legacy-rejected-dummy-${i}`);
            }
            setObservedIdsForDate(selectedDateStr, observedIds);
        }

        // 合并最新发现 of ID
        const newIds = currentIds.filter(id => !observedIds.includes(id));
        if (newIds.length > 0) {
            observedIds = [...observedIds, ...newIds];
            setObservedIdsForDate(selectedDateStr, observedIds);
        }

        // 计算退单：历史曾观测到但在当前列表中缺失的 ID 数量
        const missingIds = observedIds.filter(id => !currentIds.includes(id));
        const rejectedCount = missingIds.length;

        // 保存到全局缓存以供导出 (v3.6 区分初审与复审)
        currentDayStats = {
            dateStr: selectedDateStr,
            hourlyStats: hourlyStats,
            hourlyReworkStats: hourlyReworkStats,
            totalCount: totalFirst,
            totalRework: totalRework,
            totalAudits: totalAudits,
            speedPerHour: speedPerHour,
            totalSpeedPerHour: totalSpeedPerHour,
            activeHours: activeHours,
            observedCount: observedIds.length,
            rejectedCount: rejectedCount
        };

        if (isToday) {
            updateFloatingUI(records);
        }

        // 每日审核目标加载与比例计算
        const target = getTargetForDate(selectedDateStr);
        const progressPercentage = target > 0 ? ((totalFirst / target) * 100).toFixed(1) : '0.0';

        // 计算完成目标所需要的时速 (基于初审量)
        let reqSpeedText = '';
        if (isToday) {
            const remainingHours = 8 - activeHours;
            let reqSpeed = '0.0';
            if (totalFirst < target) {
                reqSpeed = remainingHours > 0 ? ((target - totalFirst) / remainingHours).toFixed(1) : (target - totalFirst).toFixed(1);
            }
            reqSpeedText = `完成初审目标所需时速: <span style="font-weight:600; color: #a855f7;">${reqSpeed}</span> 单/h`;
        } else {
            const reqSpeed = (target / 8).toFixed(1);
            reqSpeedText = `达成初审目标标准时速: <span style="font-weight:600; color: #a855f7;">${reqSpeed}</span> 单/h`;
        }

        // 针对初审计算防摆烂贴士
        let tipsHtml = '';
        let tipsColor = '#94a3b8';
        if (totalFirst >= target) {
            tipsHtml = `🎉 初审已达成目标！开始摸鱼！`;
            tipsColor = '#10b981';
        } else {
            if (parseFloat(speedPerHour) === 0) {
                tipsHtml = `🐢 赶紧开工做一单吧！`;
                tipsColor = '#94a3b8';
            } else {
                const remainingHours = 8 - activeHours;
                let reqSpeed = 0;
                if (remainingHours > 0) {
                    reqSpeed = (target - totalFirst) / remainingHours;
                }
                const currentSpeed = parseFloat(speedPerHour);
                if (currentSpeed >= reqSpeed) {
                    tipsHtml = `⚡ 效率超棒！继续保持！`;
                    tipsColor = '#60a5fa';
                } else if (currentSpeed < reqSpeed * 0.7) {
                    tipsHtml = `⚠️ 进度告急！别摆了干活！`;
                    tipsColor = '#ef4444';
                } else {
                    tipsHtml = `🐢 速度稍慢哦，搞紧搞完！`;
                    tipsColor = '#f59e0b';
                }
            }
        }

        // Card 2 动态指标参数计算
        let card2Title = '工作平均时速 (初审)';
        let card2ValueHtml = `<div style="display: flex; align-items: baseline; justify-content: center; gap: 2px;">${speedPerHour}<span style="font-size:12px; font-weight:500;">单/h</span></div>`;
        let card2SubtextHtml = `
            <div style="font-size: 10px; color: #64748b; text-align: center; width:100%; border-top: 1px solid rgba(168, 85, 247, 0.1); padding-top: 6px; margin-top: 4px; display:flex; flex-direction:column; gap:2px;">
                <div>${reqSpeedText}</div>
            </div>
        `;

        if (isToday) {
            let targetHour = nowHour;
            if (nowHour === 8) targetHour = 9;
            else if (nowHour === 12) targetHour = 11;
            else if (nowHour === 18) targetHour = 17;

            const isCoreHour = displayHours.includes(targetHour);
            if (isCoreHour) {
                card2Title = '当前小时时速 (全部)';
                const curHourFirst = hourlyStats[targetHour];
                const curHourRework = hourlyReworkStats[targetHour];
                const curHourTotal = curHourFirst + curHourRework;
                const curHourActiveHours = activeInfo.hourlyActiveHours[targetHour] || 0;
                const curHourSpeed = curHourActiveHours > 0 ? (curHourTotal / curHourActiveHours).toFixed(1) : '0.0';

                // 计算当前时速与所需时速的差异（基于初审目标，用总速度对比判断是否跟得上）
                const remainingHours = 8 - activeHours;
                let reqSpeedNum = 0;
                if (totalFirst < target && remainingHours > 0) {
                    reqSpeedNum = (target - totalFirst) / remainingHours;
                }
                const currentSpeedNum = parseFloat(curHourSpeed);
                let diffLabel = '';
                if (curHourTotal > 0) {
                    const diff = currentSpeedNum - reqSpeedNum;
                    if (diff >= 0) {
                        diffLabel = `<span style="color: #10b981; font-weight: 600; font-size: 9.5px; margin-top: 1px; display: block;">当前时速超前 ${diff.toFixed(1)} 单/h ⚡</span>`;
                    } else {
                        diffLabel = `<span style="color: #ef4444; font-weight: 600; font-size: 9.5px; margin-top: 1px; display: block;">当前时速落后 ${Math.abs(diff).toFixed(1)} 单/h 🐢</span>`;
                    }
                } else {
                    diffLabel = `<span style="color: #94a3b8; font-weight: 600; font-size: 9.5px; margin-top: 1px; display: block;">本小时暂无审核 🐢</span>`;
                }

                card2ValueHtml = `<div style="display: flex; align-items: baseline; justify-content: center; gap: 2px;">${curHourSpeed}<span style="font-size:12px; font-weight:500;">单/h</span></div>${diffLabel}`;
                card2SubtextHtml = `
                    <div style="display:flex; flex-direction:column; width:100%; border-top: 1px solid rgba(168, 85, 247, 0.1); padding-top: 6px; margin-top: 4px; gap: 2px;">
                        <div style="display:flex; justify-content:space-between; font-size:10px; color:#64748b;">
                            <span>今日均速: <span style="font-weight:600; color:#cbd5e1;">${totalSpeedPerHour}单/h</span></span>
                        </div>
                        <div style="font-size: 10px; text-align: left; color:#64748b;">
                            ${reqSpeedText}
                        </div>
                    </div>
                `;

            } else {
                card2SubtextHtml = `
                    <div style="display:flex; flex-direction:column; width:100%; border-top: 1px solid rgba(168, 85, 247, 0.1); padding-top: 6px; margin-top: 4px; gap: 2px;">
                        <div style="display:flex; justify-content:space-between; font-size:10px; color:#64748b;">
                            <span>当前非核心工时段 (${String(nowHour).padStart(2, '0')}:${String(nowMin).padStart(2, '0')})</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; font-size:10px; color:#64748b;">
                            <span>今日均速: <span style="font-weight:600; color:#cbd5e1;">${totalSpeedPerHour}单/h</span></span>
                        </div>
                        <div style="font-size: 10px; text-align: left; color:#64748b;">
                            ${reqSpeedText}
                        </div>
                    </div>
                `;
            }
        }


        // 智能预测计算 (基于初审)
        let predictionHtml = '';
        if (totalFirst >= target) {
            predictionHtml = `
                <div style="font-size: 10px; color: #10b981; font-weight: 600; text-align: left; margin-top: 6px; display: flex; align-items: center; gap: 4px;">
                    <svg viewBox="0 0 24 24" style="width:12px; height:12px; fill:none; stroke:currentColor; stroke-width:3; stroke-linecap:round; stroke-linejoin:round;"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    初审目标已达成！超额 ${totalFirst - target} 单
                </div>
            `;
        } else {
            const remaining = target - totalFirst;
            if (parseFloat(speedPerHour) > 0) {
                const hoursNeeded = remaining / parseFloat(speedPerHour);
                const hPart = Math.floor(hoursNeeded);
                const mPart = Math.round((hoursNeeded - hPart) * 60);
                let timeStr = "";
                if (hPart > 0) timeStr += `${hPart}小时`;
                if (mPart > 0 || hPart === 0) timeStr += `${mPart}分钟`;
                predictionHtml = `
                    <div style="font-size: 10px; color: #94a3b8; font-weight: 500; text-align: left; margin-top: 6px;">
                        预测: 距初审还差 <span style="color:#60a5fa; font-weight:600;">${remaining}</span> 单，约需 <span style="color:#f59e0b; font-weight:600;">${timeStr}</span>
                    </div>
                `;
            } else {
                predictionHtml = `
                    <div style="font-size: 10px; color: #64748b; font-weight: 500; text-align: left; margin-top: 6px;">
                        预测: 距初审还差 ${remaining} 单 (等待开始工作以估算)
                    </div>
                `;
            }
        }

        // 明细表格 HTML 生成
        let tableRowsHtml = '';
        displayHours.forEach(hour => {
            const countFirst = hourlyStats[hour];
            const countRework = hourlyReworkStats[hour];
            const countTotal = countFirst + countRework;
            let timeLabel = `${String(hour).padStart(2, '0')}:00 - ${String(hour).padStart(2, '0')}:59`;

            if (hour === 9) {
                timeLabel = `09:00 - 09:59 <span style="color:#475569; font-size:10px; font-weight:normal;">(含8点提前量)</span>`;
            } else if (hour === 11) {
                timeLabel = `11:00 - 11:59 <span style="color:#475569; font-size:10px; font-weight:normal;">(含12点午休量)</span>`;
            } else if (hour === 17) {
                timeLabel = `17:00 - 17:59 <span style="color:#475569; font-size:10px; font-weight:normal;">(含18点加班量)</span>`;
            }

            const countColor = countTotal > 0 ? '#f1f5f9' : '#475569';
            const countWeight = countTotal > 0 ? '700' : '500';
            const labelColor = countTotal > 0 ? '#94a3b8' : '#475569';

            let countDisplay = `${countFirst} 单`;
            if (countRework > 0) {
                countDisplay = `${countFirst} <span style="color: #a855f7; font-size: 11px; font-weight: 500;">+${countRework}复</span> 单`;
            }

            tableRowsHtml += `
                <tr style="${countTotal === 0 ? 'opacity: 0.65;' : ''}">
                    <td style="font-weight: 600; color: ${labelColor};">${timeLabel}</td>
                    <td style="font-weight: ${countWeight}; color: ${countColor}; font-size: 14px;">${countDisplay}</td>
                </tr>
            `;
        });

        // 每日审核最高记录观测判定
        let rejectedHtml = '';
        if (rejectedCount > 0) {
            rejectedHtml = `<span style="color: #ef4444; font-size: 10.5px; font-weight: 600; background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 4px; padding: 1px 5px; display: inline-flex; align-items: center; gap: 2px; cursor: help; vertical-align: middle; margin-bottom: 2px;" title="该日期曾观测到过共 ${observedIds.length} 单审核，现缺失了 ${rejectedCount} 单，可能已被审核管理员退单">⚠️ 退单: ${rejectedCount}</span>`;
        }

        const content = document.getElementById('sj-stats-content');
        content.innerHTML = `
            <!-- 数字汇总指标卡片 -->
            <div class="sj-stats-grid">
                <div class="sj-stats-box sj-box-blue" style="justify-content: space-between; height: 130px; padding: 12px; position: relative;">
                    <div style="display: flex; align-items: center; gap: 4px; width: 100%;">
                        <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: none; stroke: #3b82f6; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                        <span class="sj-stats-box-label" style="flex: 1; text-align: left;">今日初审量 (考核)</span>
                        <span id="sj-target-edit" class="sj-target-edit-btn" title="设置每日目标" style="cursor: pointer; opacity: 0.5; display: inline-flex; align-items: center; transition: all 0.2s; color: #60a5fa;">
                            <svg viewBox="0 0 24 24" style="width: 12px; height: 12px; fill: currentColor;"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                        </span>
                    </div>
                    <div class="sj-stats-box-value sj-text-blue" style="font-size: 24px; display: flex; align-items: center; justify-content: center; gap: 6px;">
                        ${totalFirst}
                        <span style="font-size: 13px; color: #64748b; font-weight: 500; margin-left: 2px;">/ ${totalAudits} 总量</span>
                        ${rejectedHtml}
                    </div>
                    <div style="width: 100%;">
                        <div style="display: flex; justify-content: space-between; font-size: 10px; color: #64748b; margin-bottom: 2px;">
                            <span>目标: <span id="sj-target-text" style="font-weight:600;">${target}</span></span>
                            <span id="sj-target-pct" style="font-weight:600; color:#60a5fa;">${progressPercentage}%</span>
                        </div>
                        <div style="width: 100%; height: 4px; background: rgba(59, 130, 246, 0.1); border-radius: 2px; overflow: hidden;">
                            <div id="sj-target-bar" style="width: ${Math.min(100, parseFloat(progressPercentage))}%; height: 100%; background: #3b82f6; border-radius: 2px; transition: width 0.5s ease-out;"></div>
                        </div>
                        ${predictionHtml}
                    </div>

                    <!-- 每日目标弹窗编辑层 -->
                    <div id="sj-target-popover" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(9, 13, 22, 0.96); backdrop-filter: blur(6px); display: none; flex-direction: column; align-items: center; justify-content: center; gap: 8px; border-radius: 16px; padding: 12px; z-index: 10; border: 1px solid rgba(59, 130, 246, 0.35);">
                        <div style="font-size: 11px; color: #94a3b8; font-weight: 600;">设置每日目标单量</div>
                        <div style="display: flex; gap: 6px; width: 100%; justify-content: center; align-items: center;">
                            <input type="number" id="sj-target-input" value="${target}" style="width: 70px; background: #1e293b; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 4px 6px; color: white; font-size: 13px; font-weight: 600; outline: none; text-align: center;">
                            <button id="sj-target-save" style="background: #3b82f6; border: none; border-radius: 6px; padding: 4px 10px; color: white; font-size: 11px; font-weight: 600; cursor: pointer; transition: background 0.2s;">保存</button>
                            <button id="sj-target-cancel" style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 4px 10px; color: #94a3b8; font-size: 11px; cursor: pointer;">取消</button>
                        </div>
                    </div>
                </div>
                <div class="sj-stats-box sj-box-purple" style="justify-content: space-between; height: 130px; padding: 12px;">
                    <div style="display: flex; align-items: center; gap: 4px; width: 100%;">
                        <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: none; stroke: #a855f7; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                        <span class="sj-stats-box-label" style="flex: 1; text-align: left;">${card2Title}</span>
                    </div>
                    <div class="sj-stats-box-value sj-text-purple" style="font-size: 24px; display: flex; flex-direction: column; align-items: center; line-height: 1.1; width: 100%; text-align: center;">${card2ValueHtml}</div>
                    ${card2SubtextHtml}
                </div>
                <div class="sj-stats-box sj-box-amber" style="justify-content: space-between; height: 130px; padding: 12px;">
                    <div style="display: flex; align-items: center; gap: 4px; width: 100%;">
                        <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: none; stroke: #f59e0b; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                        <span class="sj-stats-box-label" style="flex: 1; text-align: left;">活跃工作时数</span>
                    </div>
                    <div class="sj-stats-box-value sj-text-amber" style="font-size: 26px;">${activeHours.toFixed(1)}<span style="font-size:12px; font-weight:500; margin-left:2px;">小时</span></div>
                    <div style="width: 100%;">
                        <div style="display: flex; justify-content: space-between; font-size: 10px; color: #64748b; margin-bottom: 2px;">
                            <span>常规工时: 8h</span>
                            <span style="font-weight:600; color:#f59e0b;">${(activeHours / 8 * 100).toFixed(0)}%</span>
                        </div>
                        <div style="width: 100%; height: 4px; background: rgba(245, 158, 11, 0.1); border-radius: 2px; overflow: hidden;">
                            <div style="width: ${Math.min(100, (activeHours / 8 * 100))}%; height: 100%; background: #f59e0b; border-radius: 2px; transition: width 0.5s ease-out;"></div>
                        </div>
                        <div style="display: flex; justify-content: space-between; font-size: 10px; margin-top: 6px;">
                            <span style="color: #64748b;">${isToday ? '剩余常规工时' : '偏离工时'}</span>
                            <span style="color: #cbd5e1; font-weight: 600;">${Math.abs(activeHours - 8).toFixed(1)}h</span>
                        </div>
                        <div style="color: ${tipsColor}; font-weight: 600; font-size: 10px; text-align: left; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%;" title="${tipsHtml}">
                            ${tipsHtml}
                        </div>
                    </div>
                </div>
            </div>

            <!-- ECharts 个人效率折线趋势图 -->
            <div class="sj-chart-wrapper">
                <h4 class="sj-chart-title">单日工作效率走势 (12:00-13:00午休单量已自动归入11点，虚线为昨日总量)</h4>
                <div id="sj-stats-chart-div"></div>
            </div>

            <!-- 详细表格 -->
            <div class="sj-details-wrapper">
                <h4 class="sj-details-title">工作时段审核明细</h4>
                <div style="border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; overflow: hidden; background: rgba(255,255,255,0.01);">
                    <table class="sj-details-table">
                        <thead>
                            <tr>
                                <th>时间段</th>
                                <th>审核订单数</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${tableRowsHtml}
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        // 重新绑定目标设置按钮和弹窗事件
        const editBtn = document.getElementById('sj-target-edit');
        const popover = document.getElementById('sj-target-popover');
        const targetInput = document.getElementById('sj-target-input');
        const targetSaveBtn = document.getElementById('sj-target-save');
        const targetCancelBtn = document.getElementById('sj-target-cancel');

        if (editBtn && popover && targetInput) {
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                popover.style.display = 'flex';
                targetInput.focus();
                targetInput.select();
            });

            targetCancelBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                popover.style.display = 'none';
            });

            // 点击外部关闭弹窗
            document.addEventListener('click', function closePopover(event) {
                if (popover && popover.style.display === 'flex' && !popover.contains(event.target)) {
                    popover.style.display = 'none';
                    document.removeEventListener('click', closePopover);
                }
            });

            targetSaveBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const parsed = parseInt(targetInput.value, 10);
                if (!isNaN(parsed) && parsed > 0) {
                    setTargetForDate(selectedDateStr, parsed);

                    // 重新加载统计以更新所有卡片和走势图的计算
                    loadStats();
                } else {
                    alert("请输入有效的正整数！");
                }
            });
        }

        if (targetInput) {
            targetInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    targetSaveBtn.click();
                } else if (e.key === 'Escape') {
                    e.stopPropagation(); // 阻止事件冒泡，避免同时关闭整个面板
                    targetCancelBtn.click();
                }
            });
        }

        // 异步渲染 ECharts 堆叠柱状趋势图 (v3.6)
        setTimeout(() => {
            initEChart(hourlyStats, hourlyReworkStats, yesterdayHourlyStats, yesterdayHourlyReworkStats);
        }, 50);
    };    // 渲染近 7 日周分析页面 (v1.8新增, v3.6 升级区分初审复审)
    const renderWeeklyStats = (records) => {
        // 执行自愈自净化，消除跨天合并数据造成的 ID 污染
        sanitizeAllObservedIds(records);

        // 1. 初始化最后7天的数据
        const today = new Date();
        const dateList = [];
        const dateLabels = [];
        const weeklyData = {};

        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(today.getDate() - i);
            const dateStr = formatDate(d);
            dateList.push(dateStr);
            dateLabels.push(dateStr.substring(5)); // M-D 格式 e.g., '06-21'
            weeklyData[dateStr] = {
                total: 0,
                firstRound: 0,
                rework: 0,
                activeHours: 0,
                hourlyStats: Array.from({ length: 24 }, () => 0),
                hourlyReworkStats: Array.from({ length: 24 }, () => 0)
            };
        }

        // 2. 统计单量
        records.forEach(item => {
            if (item.reviewedtime) {
                const dateStr = item.reviewedtime.substring(0, 10);
                if (weeklyData[dateStr]) {
                    const isFirst = isFirstRoundAudit(item);
                    if (isFirst) {
                        weeklyData[dateStr].firstRound++;
                    } else {
                        weeklyData[dateStr].rework++;
                    }
                    weeklyData[dateStr].total++;

                    let hour = parseInt(item.reviewedtime.substring(11, 13), 10);
                    if (hour === 8) hour = 9;
                    else if (hour === 12) hour = 11;
                    else if (hour === 18) hour = 17;
                    if (hour >= 0 && hour < 24) {
                        if (isFirst) {
                            weeklyData[dateStr].hourlyStats[hour]++;
                        } else {
                            weeklyData[dateStr].hourlyReworkStats[hour]++;
                        }
                    }
                }
            }
        });

        // 3. 计算活跃工时
        const displayHours = [9, 10, 11, 13, 14, 15, 16, 17];
        let totalWeeklyFirst = 0;
        let totalWeeklyRework = 0;
        let totalWeeklyActiveHours = 0;
        let goalMetDays = 0;
        const target = parseInt(localStorage.getItem('sj_stats_target') || '200', 10);

        dateList.forEach(dateStr => {
            const dayInfo = weeklyData[dateStr];
            totalWeeklyFirst += dayInfo.firstRound;
            totalWeeklyRework += dayInfo.rework;

            // 计算当天活跃工时
            let dayActiveHours = 0;
            displayHours.forEach(h => {
                if (dayInfo.hourlyStats[h] > 0 || dayInfo.hourlyReworkStats[h] > 0) {
                    dayActiveHours++;
                }
            });
            dayInfo.activeHours = dayActiveHours;
            totalWeeklyActiveHours += dayActiveHours;

            const dayTarget = getTargetForDate(dateStr);
            if (dayInfo.firstRound >= dayTarget) { // 达标只针对初审！
                goalMetDays++;
            }
        });

        const totalWeeklyAudits = totalWeeklyFirst + totalWeeklyRework;
        const weeklyAvgSpeed = totalWeeklyActiveHours > 0 ? (totalWeeklyFirst / totalWeeklyActiveHours).toFixed(1) : '0.0';
        const weeklyAvgTotalSpeed = totalWeeklyActiveHours > 0 ? (totalWeeklyAudits / totalWeeklyActiveHours).toFixed(1) : '0.0';

        // 4. 保存缓存以供 CSV 导出
        currentWeeklyStats = {
            dateLabels: dateLabels,
            dateList: dateList,
            weeklyData: weeklyData,
            totalWeeklyFirst: totalWeeklyFirst,
            totalWeeklyRework: totalWeeklyRework,
            totalWeeklyAudits: totalWeeklyAudits,
            weeklyAvgSpeed: weeklyAvgSpeed,
            weeklyAvgTotalSpeed: weeklyAvgTotalSpeed,
            totalWeeklyActiveHours: totalWeeklyActiveHours,
            goalMetDays: goalMetDays,
            weeklyRecords: records
        };

        // 5. 渲染周指标 HTML
        const content = document.getElementById('sj-stats-content');
        content.innerHTML = `
            <!-- 数字汇总指标卡片 -->
            <div class="sj-stats-grid">
                <div class="sj-stats-box sj-box-blue" style="justify-content: space-between; height: 110px; padding: 16px 12px;">
                    <div style="display: flex; align-items: center; gap: 4px; width: 100%;">
                        <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: none; stroke: #3b82f6; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                        <span class="sj-stats-box-label" style="flex: 1; text-align: left;">近7日初审总量</span>
                    </div>
                    <div class="sj-stats-box-value sj-text-blue" style="font-size: 24px; display: flex; align-items: center; justify-content: center; gap: 6px;">
                        ${totalWeeklyFirst}
                        <span style="font-size: 13px; color: #64748b; font-weight: 500; margin-left: 2px;">/ ${totalWeeklyAudits} 总量</span>
                    </div>
                    <div style="font-size: 10px; color: #64748b; text-align: center; width: 100%; border-top: 1px solid rgba(59, 130, 246, 0.1); padding-top: 6px;">
                        日均初审: <span style="font-weight:600; color: #3b82f6;">${(totalWeeklyFirst / 7).toFixed(0)}</span> 单/天 (总量: ${(totalWeeklyAudits / 7).toFixed(0)})
                    </div>
                </div>
                <div class="sj-stats-box sj-box-purple" style="justify-content: space-between; height: 110px; padding: 16px 12px;">
                    <div style="display: flex; align-items: center; gap: 4px; width: 100%;">
                        <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: none; stroke: #a855f7; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                        <span class="sj-stats-box-label" style="flex: 1; text-align: left;">周均初审时速</span>
                    </div>
                    <div class="sj-stats-box-value sj-text-purple" style="font-size: 24px;">${weeklyAvgSpeed}<span style="font-size:12px; font-weight:500; margin-left:2px;">单/h</span></div>
                    <div style="font-size: 10px; color: #64748b; text-align: center; width:100%; border-top: 1px solid rgba(168, 85, 247, 0.1); padding-top: 6px;">
                        周均总速: <span style="font-weight:600; color: #cbd5e1;">${weeklyAvgTotalSpeed}单/h</span> | 总时长: ${totalWeeklyActiveHours}h
                    </div>
                </div>
                <div class="sj-stats-box sj-box-amber" style="justify-content: space-between; height: 110px; padding: 16px 12px;">
                    <div style="display: flex; align-items: center; gap: 4px; width: 100%;">
                        <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: none; stroke: #f59e0b; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                        <span class="sj-stats-box-label" style="flex: 1; text-align: left;">目标达成天数</span>
                    </div>
                    <div class="sj-stats-box-value sj-text-amber" style="font-size: 28px;">${goalMetDays}<span style="font-size:12px; font-weight:500; margin-left:2px;">天</span></div>
                    <div style="width: 100%;">
                        <div style="display: flex; justify-content: space-between; font-size: 10px; color: #64748b; margin-bottom: 2px;">
                            <span>目标: ${target}单</span>
                            <span style="font-weight:600; color:#f59e0b;">${(goalMetDays / 7 * 100).toFixed(0)}%</span>
                        </div>
                        <div style="width: 100%; height: 4px; background: rgba(245, 158, 11, 0.1); border-radius: 2px; overflow: hidden;">
                            <div style="width: ${(goalMetDays / 7 * 100).toFixed(0)}%; height: 100%; background: #f59e0b; border-radius: 2px; transition: width 0.5s ease-out;"></div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- ECharts 周效能趋势图 -->
            <div class="sj-chart-wrapper">
                <h4 class="sj-chart-title">近 7 日审核单量分布趋势走势 (柱状图堆叠展示初审与复审)</h4>
                <div id="sj-stats-chart-div"></div>
            </div>

            <!-- 周报明细表 -->
            <div class="sj-details-wrapper">
                <h4 class="sj-details-title">近 7 日效能明细报表</h4>
                <div style="border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; overflow: hidden; background: rgba(255,255,255,0.01);">
                    <table class="sj-details-table">
                        <thead>
                            <tr>
                                <th>日期</th>
                                <th>审核单量 (初审)</th>
                                <th>活跃工时</th>
                                <th>当日初审均速</th>
                                <th>状态</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${dateList.map(dateStr => {
                                const dayInfo = weeklyData[dateStr];
                                const daySpeed = dayInfo.activeHours > 0 ? (dayInfo.firstRound / dayInfo.activeHours).toFixed(1) : '0.0';
                                const dayTotalSpeed = dayInfo.activeHours > 0 ? (dayInfo.total / dayInfo.activeHours).toFixed(1) : '0.0';
                                const dayTarget = getTargetForDate(dateStr);
                                const isGoalMet = dayInfo.firstRound >= dayTarget;
                                const statusColor = isGoalMet ? '#10b981' : '#ef4444';
                                const statusBg = isGoalMet ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)';
                                const statusText = isGoalMet ? `达标 (目标 ${dayTarget})` : `未达标 (目标 ${dayTarget})`;

                                // 计算退单 (v3.5)
                                const dayRecords = records.filter(item => item.reviewedtime && item.reviewedtime.startsWith(dateStr));
                                const currentIds = dayRecords.map(item => item.id || item.reviewedtime);
                                let observedIds = getObservedIdsForDate(dateStr);

                                // 兼容 v3.4 升级
                                const legacyMax = getMaxObservedForDate(dateStr);
                                if (observedIds.length === 0 && legacyMax > currentIds.length) {
                                    observedIds = [...currentIds];
                                    const diff = legacyMax - currentIds.length;
                                    for (let i = 0; i < diff; i++) {
                                        observedIds.push(`legacy-rejected-dummy-${i}`);
                                    }
                                    setObservedIdsForDate(dateStr, observedIds);
                                }

                                // 合并最新发现的 ID
                                const newIds = currentIds.filter(id => !observedIds.includes(id));
                                if (newIds.length > 0) {
                                    observedIds = [...observedIds, ...newIds];
                                    setObservedIdsForDate(dateStr, observedIds);
                                }

                                // 计算退单
                                const missingIds = observedIds.filter(id => !currentIds.includes(id));
                                const rejectedCount = missingIds.length;

                                let rejectedLabel = '';
                                if (rejectedCount > 0) {
                                    rejectedLabel = ` <span style="color: #ef4444; font-size: 9px; font-weight: 600; background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 3px; padding: 1px 4px; margin-left: 4px; display: inline-block; vertical-align: middle; cursor: help;" title="该日期曾观测到过共 ${observedIds.length} 单审核，现缺失了 ${rejectedCount} 单，可能已被审核管理员退单">退 ${rejectedCount}</span>`;
                                }

                                let dayInfoCountDisplay = `${dayInfo.firstRound} 单`;
                                if (dayInfo.rework > 0) {
                                    dayInfoCountDisplay = `${dayInfo.firstRound} <span style="color: #a855f7; font-size: 11.5px; font-weight: 500;">+${dayInfo.rework}防</span> 单`;
                                }

                                // Wait, the plan requested '复', let's use '复' for consistency
                                dayInfoCountDisplay = `${dayInfo.firstRound} 单`;
                                if (dayInfo.rework > 0) {
                                    dayInfoCountDisplay = `${dayInfo.firstRound} <span style="color: #a855f7; font-size: 11.5px; font-weight: 500;">+${dayInfo.rework}复</span> 单`;
                                }

                                let daySpeedDisplay = `${daySpeed} 单/h`;
                                if (dayInfo.rework > 0) {
                                    daySpeedDisplay = `${daySpeed} <span style="color:#a855f7; font-size:11px;">(总:${dayTotalSpeed})</span>`;
                                }

                                return `
                                    <tr>
                                        <td style="font-weight: 600; color: #94a3b8;">${dateStr}</td>
                                        <td style="font-weight: 700; color: #f1f5f9; font-size: 14px;">${dayInfoCountDisplay}${rejectedLabel}</td>
                                        <td style="color: #cbd5e1;">${dayInfo.activeHours} 小时</td>
                                        <td style="color: #cbd5e1;">${daySpeedDisplay}</td>
                                        <td>
                                            <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; color: ${statusColor}; background: ${statusBg};">${statusText}</span>
                                        </td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        // 异步渲染 ECharts 周效能趋势图 (堆叠柱状图) (v3.6)
        setTimeout(() => {
            const targetValues = dateList.map(d => getTargetForDate(d));
            initWeeklyChart(
                dateLabels,
                dateList.map(d => weeklyData[d].firstRound),
                dateList.map(d => weeklyData[d].rework),
                targetValues
            );
        }, 50);
    };    // 初始化 ECharts 堆叠柱状图 (v3.6 新增区分初审复审)
    const initEChart = (hourlyData, hourlyReworkData = [], yesterdayHourlyData = [], yesterdayHourlyReworkData = []) => {
        const chartDom = document.getElementById('sj-stats-chart-div');
        if (!chartDom) return;

        const xData = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
        
        const firstRoundSeries = [
            hourlyData[9] || 0,
            hourlyData[10] || 0,
            hourlyData[11] || 0,
            hourlyData[13] || 0,
            hourlyData[14] || 0,
            hourlyData[15] || 0,
            hourlyData[16] || 0,
            hourlyData[17] || 0
        ];

        const reworkSeries = [
            (hourlyReworkData && hourlyReworkData[9]) || 0,
            (hourlyReworkData && hourlyReworkData[10]) || 0,
            (hourlyReworkData && hourlyReworkData[11]) || 0,
            (hourlyReworkData && hourlyReworkData[13]) || 0,
            (hourlyReworkData && hourlyReworkData[14]) || 0,
            (hourlyReworkData && hourlyReworkData[15]) || 0,
            (hourlyReworkData && hourlyReworkData[16]) || 0,
            (hourlyReworkData && hourlyReworkData[17]) || 0
        ];

        const totalSeries = firstRoundSeries.map((val, idx) => val + reworkSeries[idx]);
        const maxVal = Math.max(...totalSeries);
        const hasDataPoints = maxVal > 0;

        let yesterdaySeriesData = [];
        let hasYesterdayData = yesterdayHourlyData.length > 0;
        if (hasYesterdayData) {
            yesterdaySeriesData = [
                (yesterdayHourlyData[9] || 0) + (yesterdayHourlyReworkData[9] || 0),
                (yesterdayHourlyData[10] || 0) + (yesterdayHourlyReworkData[10] || 0),
                (yesterdayHourlyData[11] || 0) + (yesterdayHourlyReworkData[11] || 0),
                (yesterdayHourlyData[13] || 0) + (yesterdayHourlyReworkData[13] || 0),
                (yesterdayHourlyData[14] || 0) + (yesterdayHourlyReworkData[14] || 0),
                (yesterdayHourlyData[15] || 0) + (yesterdayHourlyReworkData[15] || 0),
                (yesterdayHourlyData[16] || 0) + (yesterdayHourlyReworkData[16] || 0),
                (yesterdayHourlyData[17] || 0) + (yesterdayHourlyReworkData[17] || 0)
            ];
        }

        chartInstance = echarts.init(chartDom, 'dark', { renderer: 'canvas' });

        const option = {
            backgroundColor: 'transparent',
            tooltip: {
                trigger: 'axis',
                backgroundColor: '#111827',
                borderColor: 'rgba(255, 255, 255, 0.1)',
                textStyle: {
                    color: '#f3f4f6',
                    fontFamily: 'inherit',
                    fontSize: 12
                },
                axisPointer: {
                    type: 'shadow'
                },
                formatter: function (params) {
                    let timeLabel = params[0].name;
                    if (timeLabel === '09:00') {
                        timeLabel = '09:00 (含8点提前打卡数)';
                    } else if (timeLabel === '11:00') {
                        timeLabel = '11:00 (含12点午休量)';
                    } else if (timeLabel === '17:00') {
                        timeLabel = '17:00 (含18点下班尾款数)';
                    }

                    let firstVal = 0;
                    let reworkVal = 0;
                    let yestVal = 0;
                    let hasYest = false;

                    params.forEach(p => {
                        if (p.seriesName === '今日初审') {
                            firstVal = p.value;
                        } else if (p.seriesName === '今日复审') {
                            reworkVal = p.value;
                        } else if (p.seriesName === '昨日同期') {
                            yestVal = p.value;
                            hasYest = true;
                        }
                    });

                    const totalVal = firstVal + reworkVal;

                    let diffText = '';
                    if (hasYest && yestVal > 0) {
                        const pct = ((totalVal - yestVal) / yestVal * 100).toFixed(0);
                        const sign = pct >= 0 ? '+' : '';
                        const color = pct >= 0 ? '#10b981' : '#ef4444';
                        diffText = `<span style="color: ${color}; margin-left: 6px; font-weight: 600;">(${sign}${pct}%)</span>`;
                    } else if (totalVal > 0 && hasYest) {
                        diffText = `<span style="color: #10b981; margin-left: 6px; font-weight: 600;">(+100%)</span>`;
                    }

                    let html = `<div style="font-weight: 700; margin-bottom: 6px; color: #94a3b8;">${timeLabel}</div>`;
                    html += `<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom: 4px;">
                                <span style="display:flex; align-items:center; gap:6px; color:#cbd5e1;">
                                    <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#3b82f6;"></span>
                                    今日初审:
                                </span>
                                <b style="color:#ffffff;">${firstVal} 单</b>
                            </div>`;
                    html += `<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom: 4px;">
                                <span style="display:flex; align-items:center; gap:6px; color:#a855f7;">
                                    <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#a855f7;"></span>
                                    今日复审:
                                </span>
                                <b style="color:#ffffff;">${reworkVal} 单</b>
                            </div>`;
                    html += `<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom: 4px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 4px;">
                                <span style="display:flex; align-items:center; gap:6px; color:#60a5fa;">
                                    今日总量:
                                </span>
                                <b style="color:#ffffff;">${totalVal} 单 ${diffText}</b>
                            </div>`;

                    if (hasYest) {
                        html += `<div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                                    <span style="display:flex; align-items:center; gap:6px; color:#64748b;">
                                        <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:rgba(148, 163, 184, 0.4); border: 1px dashed rgba(148, 163, 184, 0.8);"></span>
                                        昨日总量:
                                    </span>
                                    <b style="color:#94a3b8;">${yestVal} 单</b>
                                </div>`;
                    }
                    return html;
                }
            },
            legend: {
                show: true,
                data: ['今日初审', '今日复审', '昨日同期'],
                textStyle: {
                    color: '#64748b',
                    fontSize: 10,
                    fontFamily: 'inherit'
                },
                top: '0%',
                right: '4%'
            },
            grid: {
                left: '3%',
                right: '5%',
                bottom: '6%',
                top: '18%',
                containLabel: true
            },
            xAxis: {
                type: 'category',
                boundaryGap: true,
                data: xData,
                axisLine: {
                    lineStyle: {
                        color: 'rgba(255, 255, 255, 0.08)'
                    }
                },
                axisLabel: {
                    color: '#64748b',
                    fontSize: 10,
                    margin: 12
                }
            },
            yAxis: {
                type: 'value',
                minInterval: 1,
                axisLine: { show: false },
                splitLine: {
                    lineStyle: {
                        color: 'rgba(255, 255, 255, 0.03)'
                    }
                },
                axisLabel: {
                    color: '#64748b',
                    fontSize: 10
                }
            },
            series: [
                {
                    name: '今日初审',
                    type: 'bar',
                    stack: 'today',
                    itemStyle: {
                        color: '#3b82f6'
                    },
                    barWidth: '40%',
                    data: firstRoundSeries
                },
                {
                    name: '今日复审',
                    type: 'bar',
                    stack: 'today',
                    itemStyle: {
                        color: '#a855f7',
                        borderRadius: [4, 4, 0, 0]
                    },
                    barWidth: '40%',
                    data: reworkSeries
                }
            ]
        };

        if (hasYesterdayData) {
            option.series.push({
                name: '昨日同期',
                type: 'line',
                smooth: true,
                showSymbol: false,
                symbol: 'circle',
                symbolSize: 4,
                itemStyle: {
                    color: '#64748b',
                    borderWidth: 1.5,
                    borderColor: '#090d16'
                },
                lineStyle: {
                    width: 2,
                    type: 'dashed',
                    color: '#64748b',
                    opacity: 0.5
                },
                data: yesterdaySeriesData
            });
        }

        chartInstance.setOption(option);

        if (resizeHandler) {
            window.removeEventListener('resize', resizeHandler);
        }
        resizeHandler = () => {
            if (chartInstance) chartInstance.resize();
        };
        window.addEventListener('resize', resizeHandler);
    };

    // 初始化 ECharts 周堆叠柱状图 (v3.6)
    const initWeeklyChart = (labels, firstRoundValues, reworkValues, targetValues) => {
        const chartDom = document.getElementById('sj-stats-chart-div');
        if (!chartDom) return;

        chartInstance = echarts.init(chartDom, 'dark', { renderer: 'canvas' });

        const option = {
            backgroundColor: 'transparent',
            tooltip: {
                trigger: 'axis',
                backgroundColor: '#111827',
                borderColor: 'rgba(255, 255, 255, 0.1)',
                textStyle: {
                    color: '#f3f4f6',
                    fontFamily: 'inherit',
                    fontSize: 12
                },
                axisPointer: {
                    type: 'shadow'
                },
                formatter: function (params) {
                    let dateLabel = params[0].name;
                    let firstVal = 0;
                    let reworkVal = 0;
                    let targetVal = 0;

                    params.forEach(p => {
                        if (p.seriesName === '初审数量') {
                            firstVal = p.value;
                        } else if (p.seriesName === '复审数量') {
                            reworkVal = p.value;
                        } else if (p.seriesName === '预设目标') {
                            targetVal = p.value;
                        }
                    });

                    const totalVal = firstVal + reworkVal;
                    const isGoalMet = firstVal >= targetVal; // 达标指针对初审
                    const statusText = isGoalMet ? '<span style="color: #10b981; font-weight: 700; margin-left: 6px;">(达标)</span>' : '<span style="color: #ef4444; font-weight: 700; margin-left: 6px;">(未达标)</span>';

                    let html = `<div style="font-weight: 700; margin-bottom: 6px; color: #94a3b8;">日期: ${dateLabel}</div>`;
                    html += `<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom: 4px;">
                                <span style="display:flex; align-items:center; gap:6px; color:#cbd5e1;">
                                    <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#3b82f6;"></span>
                                    初审数量:
                                </span>
                                <b style="color:#ffffff;">${firstVal} 单</b>
                            </div>`;
                    html += `<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom: 4px;">
                                <span style="display:flex; align-items:center; gap:6px; color:#a855f7;">
                                    <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#a855f7;"></span>
                                    复审数量:
                                </span>
                                <b style="color:#ffffff;">${reworkVal} 单</b>
                            </div>`;
                    html += `<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom: 4px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 4px;">
                                <span style="display:flex; align-items:center; gap:6px; color:#60a5fa;">
                                    总审核量:
                                </span>
                                <b style="color:#ffffff;">${totalVal} 单</b>
                            </div>`;
                    html += `<div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                                <span style="display:flex; align-items:center; gap:6px; color:#f43f5e;">
                                    <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#f43f5e;"></span>
                                    预设目标:
                                </span>
                                <b style="color:#ffffff;">${targetVal} 单 ${statusText}</b>
                            </div>`;
                    return html;
                }
            },
            legend: {
                show: true,
                data: ['初审数量', '复审数量', '预设目标'],
                textStyle: {
                    color: '#64748b',
                    fontSize: 10,
                    fontFamily: 'inherit'
                },
                top: '0%',
                right: '4%'
            },
            grid: {
                left: '3%',
                right: '5%',
                bottom: '6%',
                top: '18%',
                containLabel: true
            },
            xAxis: {
                type: 'category',
                data: labels,
                axisLine: {
                    lineStyle: {
                        color: 'rgba(255, 255, 255, 0.08)'
                    }
                },
                axisLabel: {
                    color: '#64748b',
                    fontSize: 10,
                    margin: 12
                }
            },
            yAxis: {
                type: 'value',
                minInterval: 1,
                axisLine: { show: false },
                splitLine: {
                    lineStyle: {
                        color: 'rgba(255, 255, 255, 0.03)'
                    }
                },
                axisLabel: {
                    color: '#64748b',
                    fontSize: 10
                }
            },
            series: [
                {
                    name: '初审数量',
                    type: 'bar',
                    stack: 'weekly',
                    barWidth: '35%',
                    itemStyle: {
                        color: '#3b82f6'
                    },
                    data: firstRoundValues
                },
                {
                    name: '复审数量',
                    type: 'bar',
                    stack: 'weekly',
                    barWidth: '35%',
                    itemStyle: {
                        color: '#a855f7',
                        borderRadius: [4, 4, 0, 0]
                    },
                    data: reworkValues
                },
                {
                    name: '预设目标',
                    type: 'line',
                    symbol: 'circle',
                    symbolSize: 6,
                    itemStyle: {
                        color: '#f43f5e'
                    },
                    lineStyle: {
                        color: '#f43f5e',
                        width: 2,
                        type: 'dashed'
                    },
                    data: targetValues
                }
            ]
        };

        chartInstance.setOption(option);

        if (resizeHandler) {
            window.removeEventListener('resize', resizeHandler);
        }
        resizeHandler = () => {
            if (chartInstance) chartInstance.resize();
        };
        window.addEventListener('resize', resizeHandler);
    };

    // ==========================================
    // 审核辅助增强模块 - 大图联动审核工作台 (v1.1.2)
    // ==========================================

    // 从放大对话框的标题或属性中提取题号，如 'Q7' 或 'Q10'
    function getActiveDialogQuestionNumber(dialog) {
        const label = dialog.getAttribute('aria-label') || '';
        let match = label.match(/^[qQ](\d+)/);
        if (match) return 'Q' + match[1];

        const titleEl = dialog.querySelector('.el-dialog__title, .el-dialog__header, .dialog-header, h3, h4, span');
        if (titleEl) {
            match = titleEl.textContent.trim().match(/^[qQ](\d+)/);
            if (match) return 'Q' + match[1];
        }
        return null;
    }

    // 检测网页当前是否打开了带有 Q7 或 Q10 图片的放大对话框
    function findTargetZoomDialog() {
        const dialogs = document.querySelectorAll('.el-dialog__wrapper, .el-dialog, .task-review-evidence-dialog');
        for (const d of dialogs) {
            const rect = d.getBoundingClientRect();
            // 通过 rect.width / rect.height 判定 dialog 及其所有祖先是否真实渲染（排除 display: none）
            if (rect.width > 0 && rect.height > 0) {
                const style = window.getComputedStyle(d);
                if (style && style.display !== 'none' && style.visibility !== 'hidden') {
                    if (d.querySelector('img')) {
                        const qNum = getActiveDialogQuestionNumber(d);
                        if (qNum === 'Q7' || qNum === 'Q10') {
                            return d; // 返回符合条件的当前活动对话框
                        }
                    }
                }
            }
        }
        return null;
    }

    // 智能审核工作台主渲染与同步控制
    function auditHelperCaptureScrollState(anchorEls = []) {
        const scrollTargets = new Set([document.scrollingElement || document.documentElement]);
        anchorEls.filter(Boolean).forEach((anchor) => {
            let el = anchor;
            while (el && el !== document.body && el !== document.documentElement) {
                const style = window.getComputedStyle(el);
                const canScrollY = /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
                const canScrollX = /(auto|scroll|overlay)/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
                if (canScrollY || canScrollX) scrollTargets.add(el);
                el = el.parentElement;
            }
        });

        return Array.from(scrollTargets).map((el) => ({
            el,
            left: el.scrollLeft,
            top: el.scrollTop
        }));
    }

    function auditHelperRestoreScrollState(state) {
        state.forEach(({ el, left, top }) => {
            el.scrollLeft = left;
            el.scrollTop = top;
        });
    }

    function auditHelperIsOptionChecked(opt) {
        if (!opt) return false;
        return opt.classList.contains('selected') ||
            opt.classList.contains('checked') ||
            opt.classList.contains('is-checked') ||
            opt.classList.contains('active') ||
            opt.classList.contains('is-active') ||
            !!opt.querySelector('.is-checked, .checked, .selected, .active, [class*="square-check"]');
    }

    function auditHelperClickOption(opt, activeDialog) {
        if (!opt) return false;
        const scrollState = auditHelperCaptureScrollState([opt, activeDialog]);
        const activeEl = document.activeElement;
        const clickTarget = opt.querySelector('.sj-icon-square-check, .sj-icon-square, i[class*="square"]') ||
            opt.querySelector('.option-title') ||
            opt;

        autoReviewClickCenter(clickTarget);

        auditHelperRestoreScrollState(scrollState);
        requestAnimationFrame(() => auditHelperRestoreScrollState(scrollState));
        setTimeout(() => auditHelperRestoreScrollState(scrollState), 80);
        setTimeout(() => auditHelperRestoreScrollState(scrollState), 180);

        if (activeEl && typeof activeEl.focus === 'function') {
            setTimeout(() => {
                try { activeEl.focus({ preventScroll: true }); } catch (err) { /* ignore focus restore failures */ }
            }, 0);
        }
        return true;
    }

    function auditHelperSetNativeValue(input, value) {
        const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (valueSetter) {
            valueSetter.call(input, value);
        } else {
            input.value = value;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function auditHelperIsEditableFillInput(el) {
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
        if (el.type && ['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file'].includes(el.type)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function auditHelperGetFillRow(input) {
        let el = input.parentElement;
        while (el && el !== document.body) {
            const inputs = Array.from(el.querySelectorAll('input, textarea')).filter(auditHelperIsEditableFillInput);
            if (inputs.length === 1 && el.textContent.trim()) return el;
            el = el.parentElement;
        }
        return input.parentElement || input;
    }

    function auditHelperGetFillLabel(input, index) {
        const row = auditHelperGetFillRow(input);
        const directLabel = row.querySelector('label, .el-form-item__label, [class*="label"], [class*="title"]');
        if (directLabel && directLabel.textContent.trim()) {
            return directLabel.textContent.trim();
        }
        const text = row.textContent
            .replace(input.value || '', '')
            .replace(/\s+/g, ' ')
            .trim();
        return text || `Q8 填空 ${index + 1}`;
    }

    function auditHelperGetFillInputs(card) {
        return Array.from(card.querySelectorAll('input, textarea')).filter(auditHelperIsEditableFillInput);
    }

    function auditHelperRenderFillInputs(card, listContainer, activeDialog) {
        const fillInputs = auditHelperGetFillInputs(card);
        // Clear container to prevent duplicate elements on update
        listContainer.innerHTML = '';
        if (fillInputs.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'sj-ws-empty';
            empty.textContent = '未找到 Q8 填空输入框';
            listContainer.appendChild(empty);
            return;
        }

        fillInputs.forEach((sourceInput, index) => {
            const row = document.createElement('div');
            row.className = 'sj-ws-fill-row';

            const label = document.createElement('div');
            label.className = 'sj-ws-fill-label';
            label.textContent = auditHelperGetFillLabel(sourceInput, index);

            const input = sourceInput instanceof HTMLTextAreaElement ? document.createElement('textarea') : document.createElement('input');
            input.className = 'sj-ws-fill-input';
            if (sourceInput instanceof HTMLInputElement) input.type = sourceInput.type === 'number' ? 'number' : 'text';
            input.value = sourceInput.value || '';
            input.placeholder = sourceInput.placeholder || '';

            input.addEventListener('click', (e) => e.stopPropagation());
            input.addEventListener('keydown', (e) => e.stopPropagation());
            input.addEventListener('input', () => {
                const scrollState = auditHelperCaptureScrollState([sourceInput, activeDialog]);
                auditHelperSetNativeValue(sourceInput, input.value);
                auditHelperRestoreScrollState(scrollState);
                requestAnimationFrame(() => auditHelperRestoreScrollState(scrollState));
            });
            input.addEventListener('change', () => {
                auditHelperSetNativeValue(sourceInput, input.value);
            });

            row.appendChild(label);
            row.appendChild(input);
            listContainer.appendChild(row);
        });
    }

    let activeWSDialogQNum = null; // 缓存当前放大图片所在的题号，如 'Q7' 或 'Q10'
    let activeWSTab = ''; // 缓存当前选中的工作台 Tab，如 'Q13'

    // ==========================================
    // Q7/Q10 福临门本地识油助手（无大模型、无训练、无图片上传）
    // 只读取当前题目卡左侧“照片证据”，绝不读取右侧“审核参考”或说明示例图。
    // ==========================================
    const FLM_LOCAL_OIL_REF_VERSION = 'company-ppt-20260801-v1';
    const FLM_LOCAL_OIL_REF_CACHE_KEY = 'flm_local_oil_reference_cache_' + FLM_LOCAL_OIL_REF_VERSION;
    const FLM_LOCAL_OIL_RESULT_PREFIX = 'flm_local_oil_result_v1_';
    const FLM_LOCAL_OIL_FEATURE_WIDTH = 8;
    const FLM_LOCAL_OIL_FEATURE_HEIGHT = 12;
    const FLM_LOCAL_OIL_FEATURE_LENGTH = FLM_LOCAL_OIL_FEATURE_WIDTH * FLM_LOCAL_OIL_FEATURE_HEIGHT * 3 + 14;
    const FLM_LOCAL_OIL_COMPANY_GROUPS = [
        ['flax', 8], ['sunflower', 8], ['corn', 8], ['peanut', 8],
        ['rapeseed', 10], ['soybean', 8], ['blend', 8], ['olive', 10]
    ];
    const FLM_LOCAL_OIL_CATEGORY_META = {
        sunflower: { label: '福临门葵花籽油', words: ['葵花'] },
        corn: { label: '福临门玉米油', words: ['玉米'] },
        peanut: { label: '福临门花生油', words: ['花生'] },
        soybean: { label: '福临门大豆油', words: ['大豆', '豆油'] },
        rapeseed: { label: '福临门菜籽油', words: ['菜籽'] },
        blend: { label: '福临门调和油', words: ['调和'] },
        flax: { label: '福临门亚麻籽油或胡麻油', words: ['亚麻', '胡麻'] },
        olive: { label: '福临门橄榄油或安达露西橄榄油', words: ['橄榄', '安达露西'] }
    };
    const FLM_LOCAL_OIL_REFERENCES = [
        ['peanut_488', 'peanut', '福临门压榨一级花生油', '1901740890456211456'],
        ['peanut_491', 'peanut', '福临门南派花生油', '1901740989332733952'],
        ['peanut_494', 'peanut', '福临门油酸多多花生油', '1901741099777146880'],
        ['corn_495', 'corn', '福临门营养家玉米胚芽油', '1901741139123912704'],
        ['corn_499', 'corn', '福临门黄金产地玉米油', '1901741283588325376'],
        ['corn_501', 'corn', '福临门黄金产地玉米油圆瓶', '1901741347308191744'],
        ['sunflower_502', 'sunflower', '福临门黄金小黑葵', '1901741376861257728'],
        ['sunflower_504', 'sunflower', '福临门花悦宴葵花籽油', '1901741446792888320'],
        ['sunflower_506', 'sunflower', '福临门压榨一级葵花籽油', '1901742057697460224'],
        ['rapeseed_510', 'rapeseed', '福临门老家土榨菜籽油', '1901742182717079552'],
        ['rapeseed_512', 'rapeseed', '福临门低芥酸菜籽油', '1901742239860277248'],
        ['rapeseed_519', 'rapeseed', '福临门非转基因菜籽油', '1901742493582114816'],
        ['soybean_515', 'soybean', '福临门家香味老豆油', '1901742338006990848'],
        ['soybean_518', 'soybean', '福临门非转基因大豆油礼盒', '1901742434824110080'],
        ['soybean_522', 'soybean', '福临门非转基因一级大豆油', '1901742578269306880'],
        ['soybean_523', 'soybean', '福临门非转基因一级大豆油瓶装', '1901742638595981312'],
        ['blend_508', 'blend', '福临门营养家调和油', '1901742123267014656'],
        ['blend_520', 'blend', '福临门非转基因调和油', '1901742525987307520'],
        ['blend_521', 'blend', '福临门色香味调和油', '1901742550565928960'],
        ['flax_3968', 'flax', '福临门亚麻籽油', '2008601584870100992'],
        ['flax_3969', 'flax', '福临门零反冷榨亚麻籽油', '2008601677572608000'],
        ['flax_3970', 'flax', '福临门有机亚麻籽油', '2008602056922238976'],
        ['flax_3973', 'flax', '福临门亚麻籽油瓶装', '2008602833229189120'],
        ['olive_3979', 'olive', '福临门特级初榨橄榄油', '2008604582992154624']
    ].map(([id, category, name, assetId]) => ({
        id,
        category,
        name,
        url: `https://productandservice.cofco.com/upload/1/zl/product/${assetId}.jpg`
    }));

    let flmLocalOilReferenceData = null;
    // 公司产品资料只保留颜色/布局数值指纹，不包含原图；识别全程在浏览器本地完成。
    const FLM_LOCAL_OIL_COMPANY_DESCRIPTOR_B64_FULL =
        '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imSPZnFgbV17X3lhaVl1WIlgjmNqWWVXaVlvXXBSek+KXwATaaqWWRIAAzCNnJd5MwMufLOsuZhzM2603L2wuKJ1e9fhtqiyt4J7xdOxo6i2gnrJ3q2XqsWMc8TPjYCdtIBtv9WmjqOzfGe4zqmcw7p4arfRq6LIsHdqsMyflrmlczHOAAAAAAAAAAAAAKIbkFNVUFVTVV9TVVNbU1hUVVRQVk1VU1VgVFNUXFNZVVhTUlZOVVFUWVJUVFdTVVNSVFRVUlVUU1hTXVNZU1VUUlRVVVBWX1NsU39VcFNlU1ZWWFZWVXFSmE+VV5FfeVlcVV1VXlRvUItJiFl/anVjWVVfVV1VZlR3WXZYa19sWl5VYFVdVGZUbVZ3WWpZalhcVWJVZFVpVHFWhlh0WGxVZFVjVWVVaVR8VX1WflhrVmNWYVViVWRUaFRoVGhVZFZgVq+Hi5t8kpakp3B4kGmIkKmTUVdvSG1xY81jWnZcd3RBzJheYF5bYFDJnWtPXGl2hLuWfmBll5WYwZiDgG6Mi4q/enuAcJB9a8Sfk35ld46jxcGreYCGs9HKzcm6vcLS2k2yAAAAAAAAAAAAAEsVTVVOVVRTWlFTVVZSWVFRVFJVT1RSVFVTU1RTU1RTUlRTVVBUUlNUU1VUVVNUVFBVVFVTVFlSXVJmU2BSXFJXU1JVUVZbU2RTfVdoVGRSX1NPV1JWbFOEU49ViFN9U2ZSU1ZbVn9SoFKXVplXk1VqU1dVX1R9T5pMlVaMaollbFteVV9UfEiPQ49QhGyAbGxeYFVeVHVSiU2F' +
        'WHdndmdpWl9VXVRuVn1ee1dqXm1ga1deVVxUZFNuWHBValpqWWhWWVFbakhXdG1mNFdpNlx8TJM1bG1WcYJUskR3hGp3il7AYWhjYV5cUs15WU1ZT1Ncv4JeTlpVXm+ygmhPW4uFg56EdlxcmqWJr4yAZWGJl4a0lICHaYuTjad8gIVwgYyBd4gAAAAAAAAAAAAAWRMwVVVVVVhVbFFzTlxUVVVVVVVVAAB6X2pbblp/WgAAVVVVVYVniG2BaYthoVaQYFVVVVWCcoR0h2+uTKRTimVVVVVVg3KEdYlxrUyeWYhoVVVVVYBxg3OGcadWkmOBa1VVV1SDYIdogm2NZo9jiGFVVVdUd1B/ToFYd1eBTXtPVVVXVHdOhkySVJhNn0WBTFdUV1R8T4hOrEinUKJQeE5VVVdUgFSLUptQnVGcUHlUVlZVVX9fjl2OXZBdkVqBX1VVMBcahoofFzAcABKdoBkAHBwHbLycUggcHCm5wGltJxwcQsi9coE9HBxBxsOLn0YcHEStvaedRRwdX5CVkYdYHR1jkYp9d1kdHWSYeIWIZh4dY5OCfn1lHjFemJ+dj1wxZJsAAAAAAAAAAAAAjh0AAINpjWqFbYlrnF6tTAAAAACDcIZygGmbU6pOnFkAAAAAhHKEdIZxr02ySY5knU54eINzhXWIcbJMsEqPZIdgim6Fc4V1inGrTa1NjWWJX31og3OEdYhyq0+rT4hoh2Vzc4BzgXWEcapTnlp+bn9kaWmCcIVyhnCgXZ9chGp+ZY9ZkWaPb4JyjmyWaJRnkmFzWXxcfGR+Z4Fjhl+FXXlcbVZ5TIVJhVJzV3ZQeE1vUm9UfUqDTHxcbFiMRopGc1EADIG9r3kSAAAttsB7aDMAAFjJxGxhXwECeMvAa2JuBQSFzL1xbHoJBY3NwXx5iAwFjtDFiZChDwNzyMSYkYYIBWm3zrenewoYjK6qopqIIB6GhIqNjYcmHoOMop53eCRGuQAAAAAAAAAAAADNIHRVVVVVVVVfU15RVVVVVVVVVVUAAMsAdVF6TwAAAABVVVVVAAB9bnpqf2ySaAAAVVVVVQAAfmqAb4d2inQAAFVVVVUAAHdjfWeDbYJpAABVVVVVAAB+TX9VgE94SwAAVVVVVQAAiE6XUaVHlkMAAFVVVVUAAI1Om1KmS5lDAABVVVVVAACOTZdOqUOaQQAAVVVV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';

    let flmLocalOilReferenceFeatures = null;
    let flmLocalOilRunningKey = '';
    const flmLocalOilRuntimeResults = new Map();

    GM_addStyle(`
        .sj-ws-title { display:flex; align-items:center; justify-content:space-between; gap:8px; }
        .sj-local-oil-btn { border:1px solid #22c55e; color:#bbf7d0; background:#123226; border-radius:7px; padding:5px 9px; cursor:pointer; font-size:12px; font-weight:700; white-space:nowrap; }
        .sj-local-oil-btn:hover { background:#165436; }
        .sj-local-oil-btn:disabled { opacity:.55; cursor:not-allowed; }
        .sj-local-oil-panel { margin:8px 0 10px; padding:9px; border:1px solid rgba(34,197,94,.38); border-radius:9px; background:rgba(16,40,31,.72); color:#d1fae5; font-size:12px; }
        .sj-local-oil-head { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:7px; }
        .sj-local-oil-note { color:#94a3b8; font-size:11px; line-height:1.45; }
        .sj-local-oil-grid { display:grid; grid-template-columns:1fr 1fr; gap:5px; margin-top:7px; }
        .sj-local-oil-item { display:flex; align-items:center; justify-content:space-between; gap:6px; padding:6px 7px; border-radius:7px; background:rgba(15,23,42,.72); border:1px solid rgba(148,163,184,.18); }
        .sj-local-oil-item.high { border-color:rgba(34,197,94,.72); background:rgba(20,83,45,.5); }
        .sj-local-oil-item.maybe { border-color:rgba(245,158,11,.72); background:rgba(120,53,15,.35); }
        .sj-local-oil-item.low { opacity:.68; }
        .sj-local-oil-score { font-variant-numeric:tabular-nums; font-weight:700; white-space:nowrap; }
        .sj-local-oil-badge { margin-left:auto; border-radius:999px; padding:2px 6px; font-size:10px; font-weight:700; white-space:nowrap; }
        .sj-local-oil-badge.high { color:#86efac; background:rgba(22,101,52,.55); }
        .sj-local-oil-badge.maybe { color:#fde68a; background:rgba(146,64,14,.55); }
        .sj-local-oil-badge.missing { color:#fca5a5; background:rgba(127,29,29,.55); }
        .sj-local-oil-badge.weak { color:#fdba74; background:rgba(124,45,18,.52); }
        @media (max-width: 1200px) { .sj-local-oil-grid { grid-template-columns:1fr; } }
    `);

    function flmLocalOilHash(value) {
        let hash = 2166136261;
        const text = String(value || '');
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function flmLocalOilGetQuestionCard(qNum) {
        const cards = getAllQuestionCards();
        return cards[qNum] || null;
    }

    function flmLocalOilGetOwnEvidenceSources(qNum) {
        if (qNum !== 'Q7' && qNum !== 'Q10') return [];
        const card = flmLocalOilGetQuestionCard(qNum);
        if (!card) return [];
        const evidence = findEvidenceContainer(card);
        if (!evidence || !card.contains(evidence) || evidence.closest('.sj-cloned-q5-evidence')) return [];

        const sources = [];
        evidence.querySelectorAll('img').forEach((img) => {
            if (!evidence.contains(img)) return;
            const referenceBlock = img.closest('[class*="reference"], [class*="ref-content"]');
            if (referenceBlock || img.closest('.sj-cloned-q5-evidence')) return;
            const candidates = [
                img.getAttribute('data-original'),
                img.getAttribute('data-src'),
                img.getAttribute('alt'),
                img.currentSrc,
                img.getAttribute('src')
            ];
            const normalized = candidates
                .map(flmLocalOilNormalizeImageUrl)
                .filter(Boolean)
                .filter((src) => !/icon|avatar|logo|placeholder/i.test(src));
            if (normalized[0]) sources.push(normalized[0]);
        });
        return Array.from(new Set(sources));
    }

    function flmLocalOilNormalizeImageUrl(value) {
        const text = String(value || '').trim().replace(/&amp;/g, '&');
        if (!text) return '';
        if (/^data:image\//i.test(text)) return text;
        if (!/^(?:https?:)?\/\//i.test(text)) return '';
        try {
            const url = new URL(text, location.href);
            // 页面缩略图通常附带 x-oss-process，而 alt/data-original 保存的是原图。
            // 删除转换参数既能取得清晰图，也避开部分浏览器对 OSS 缩略响应的兼容问题。
            url.searchParams.delete('x-oss-process');
            if (location.protocol === 'https:' && url.protocol === 'http:') url.protocol = 'https:';
            return url.href;
        } catch (error) {
            return '';
        }
    }

    function flmLocalOilRequestBlob(url) {
        const normalizedUrl = flmLocalOilNormalizeImageUrl(url) || String(url || '');
        if (normalizedUrl.startsWith('data:image/')) return fetch(normalizedUrl).then((response) => response.blob());

        const fetchFallback = () => fetch(normalizedUrl, { credentials: 'include', cache: 'force-cache' }).then((response) => {
            if (!response.ok) throw new Error(`站内读取失败 HTTP ${response.status}`);
            return response.blob();
        });
        if (typeof GM_xmlhttpRequest !== 'function') return fetchFallback();

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: normalizedUrl,
                responseType: 'arraybuffer',
                timeout: 25000,
                headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
                onload: (response) => {
                    const status = Number(response.status || 0);
                    const buffer = response.response;
                    if (status >= 200 && status < 300 && buffer && buffer.byteLength > 0) {
                        const contentType = String(response.responseHeaders || '').match(/content-type:\s*([^;\r\n]+)/i)?.[1] || 'image/jpeg';
                        resolve(new Blob([buffer], { type: contentType }));
                        return;
                    }
                    fetchFallback().then(resolve, (fallbackError) => {
                        reject(new Error(`图片请求失败 HTTP ${status || '未知'}；${fallbackError.message}`));
                    });
                },
                ontimeout: () => fetchFallback().then(resolve, () => reject(new Error('图片请求超时'))),
                onerror: () => fetchFallback().then(resolve, (error) => reject(new Error(`图片请求失败：${error.message}`)))
            });
        });
    }

    function flmLocalOilLoadImage(value) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            let objectUrl = '';
            img.onload = () => {
                if (objectUrl) URL.revokeObjectURL(objectUrl);
                resolve(img);
            };
            img.onerror = () => {
                if (objectUrl) URL.revokeObjectURL(objectUrl);
                reject(new Error('图片解码失败'));
            };
            if (value instanceof Blob) {
                objectUrl = URL.createObjectURL(value);
                img.src = objectUrl;
            } else {
                img.src = value;
            }
        });
    }

    async function flmLocalOilMakeReferenceDataUrl(blob) {
        const img = await flmLocalOilLoadImage(blob);
        const canvas = document.createElement('canvas');
        canvas.width = 180;
        canvas.height = 180;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, 180, 180);
        const scale = Math.min(172 / img.naturalWidth, 172 / img.naturalHeight);
        const width = Math.max(1, Math.round(img.naturalWidth * scale));
        const height = Math.max(1, Math.round(img.naturalHeight * scale));
        ctx.drawImage(img, Math.round((180 - width) / 2), Math.round((180 - height) / 2), width, height);
        return canvas.toDataURL('image/jpeg', 0.72);
    }

    async function flmLocalOilPrepareReferences(onProgress) {
        if (flmLocalOilReferenceData && flmLocalOilReferenceData.length >= 8) return flmLocalOilReferenceData;
        try {
            const cached = JSON.parse(localStorage.getItem(FLM_LOCAL_OIL_REF_CACHE_KEY) || 'null');
            if (cached && cached.version === FLM_LOCAL_OIL_REF_VERSION && Array.isArray(cached.items) && cached.items.length >= 8) {
                flmLocalOilReferenceData = cached.items;
                return flmLocalOilReferenceData;
            }
        } catch (error) {}

        const items = [];
        const chunkSize = 4;
        for (let start = 0; start < FLM_LOCAL_OIL_REFERENCES.length; start += chunkSize) {
            const chunk = FLM_LOCAL_OIL_REFERENCES.slice(start, start + chunkSize);
            const loaded = await Promise.all(chunk.map(async (reference) => {
                try {
                    const blob = await flmLocalOilRequestBlob(reference.url);
                    const dataUrl = await flmLocalOilMakeReferenceDataUrl(blob);
                    return { ...reference, dataUrl };
                } catch (error) {
                    console.warn('[福临门本地识油] 参考包装下载失败:', reference.name, error);
                    return null;
                }
            }));
            items.push(...loaded.filter(Boolean));
            if (onProgress) onProgress(Math.min(FLM_LOCAL_OIL_REFERENCES.length, start + chunk.length), FLM_LOCAL_OIL_REFERENCES.length);
        }
        if (items.length < 8) throw new Error('可用参考包装不足，请检查网络后重试');
        flmLocalOilReferenceData = items;
        try {
            localStorage.setItem(FLM_LOCAL_OIL_REF_CACHE_KEY, JSON.stringify({
                version: FLM_LOCAL_OIL_REF_VERSION,
                savedAt: Date.now(),
                items
            }));
        } catch (error) {
            console.warn('[福临门本地识油] 参考图缓存空间不足，本次仍可继续使用。');
        }
        return items;
    }

    function flmLocalOilImageCanvas(img, maxDimension = 1100) {
        const scale = Math.min(1, maxDimension / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
        canvas.height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas;
    }

    function flmLocalOilFindProductBounds(canvas) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let minX = canvas.width;
        let minY = canvas.height;
        let maxX = 0;
        let maxY = 0;
        for (let y = 0; y < canvas.height; y += 2) {
            for (let x = 0; x < canvas.width; x += 2) {
                const index = (y * canvas.width + x) * 4;
                const r = data[index];
                const g = data[index + 1];
                const b = data[index + 2];
                const nearWhite = r > 242 && g > 242 && b > 242 && Math.max(r, g, b) - Math.min(r, g, b) < 10;
                if (nearWhite || data[index + 3] < 20) continue;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
        }
        if (maxX <= minX || maxY <= minY) return { x: 0, y: 0, width: canvas.width, height: canvas.height };
        const padX = Math.round((maxX - minX) * 0.04);
        const padY = Math.round((maxY - minY) * 0.04);
        return {
            x: Math.max(0, minX - padX),
            y: Math.max(0, minY - padY),
            width: Math.min(canvas.width - Math.max(0, minX - padX), maxX - minX + padX * 2),
            height: Math.min(canvas.height - Math.max(0, minY - padY), maxY - minY + padY * 2)
        };
    }

    function flmLocalOilFingerprint(sourceCanvas, crop, scratch) {
        const width = FLM_LOCAL_OIL_FEATURE_WIDTH;
        const height = FLM_LOCAL_OIL_FEATURE_HEIGHT;
        const canvas = scratch && scratch.canvas || document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = scratch && scratch.ctx || canvas.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(sourceCanvas, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
        const pixels = ctx.getImageData(0, 0, width, height).data;
        const chroma = [];
        const luma = [];
        const hueHist = new Array(12).fill(0);
        let saturationSum = 0;
        let texture = 0;
        const gray = new Float32Array(width * height);

        for (let i = 0; i < width * height; i++) {
            const r = pixels[i * 4] / 255;
            const g = pixels[i * 4 + 1] / 255;
            const b = pixels[i * 4 + 2] / 255;
            const sum = r + g + b + 0.001;
            chroma.push(r / sum, g / sum);
            const y = r * 0.299 + g * 0.587 + b * 0.114;
            luma.push(y);
            gray[i] = y;
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const delta = max - min;
            const saturation = max <= 0.001 ? 0 : delta / max;
            saturationSum += saturation;
            let hue = 0;
            if (delta > 0.001) {
                if (max === r) hue = ((g - b) / delta + 6) % 6;
                else if (max === g) hue = (b - r) / delta + 2;
                else hue = (r - g) / delta + 4;
                hue /= 6;
            }
            if (saturation > 0.18 && y > 0.08 && y < 0.96) hueHist[Math.min(11, Math.floor(hue * 12))] += saturation;
        }
        for (let y = 1; y < height; y++) {
            for (let x = 1; x < width; x++) {
                const index = y * width + x;
                texture += Math.abs(gray[index] - gray[index - 1]) + Math.abs(gray[index] - gray[index - width]);
            }
        }
        const histTotal = hueHist.reduce((sum, value) => sum + value, 0) || 1;
        for (let i = 0; i < hueHist.length; i++) hueHist[i] /= histTotal;
        return {
            chroma,
            luma,
            hueHist,
            saturation: saturationSum / (width * height),
            texture: texture / ((width - 1) * (height - 1) * 2)
        };
    }

    function flmLocalOilFeatureSimilarity(a, b) {
        let chromaDistance = 0;
        for (let i = 0; i < a.chroma.length; i++) chromaDistance += Math.abs(a.chroma[i] - b.chroma[i]);
        chromaDistance /= a.chroma.length;
        let lumaDistance = 0;
        for (let i = 0; i < a.luma.length; i++) lumaDistance += Math.abs(a.luma[i] - b.luma[i]);
        lumaDistance /= a.luma.length;
        let histDistance = 0;
        for (let i = 0; i < a.hueHist.length; i++) histDistance += Math.abs(a.hueHist[i] - b.hueHist[i]);
        histDistance /= 2;
        const textureDistance = Math.min(1, Math.abs(a.texture - b.texture) * 4);
        const saturationDistance = Math.min(1, Math.abs(a.saturation - b.saturation) * 2.5);
        const distance = chromaDistance * 1.45 + lumaDistance * 0.18 + histDistance * 0.42 + textureDistance * 0.12 + saturationDistance * 0.08;
        return Math.max(0, Math.min(1, 1 - distance));
    }

    function flmLocalOilDecodeFeature(bytes, offset) {
        const featureEnd = offset + FLM_LOCAL_OIL_FEATURE_LENGTH;
        if (featureEnd > bytes.length) throw new Error('公司包装特征数据不完整');
        const chromaLength = FLM_LOCAL_OIL_FEATURE_WIDTH * FLM_LOCAL_OIL_FEATURE_HEIGHT * 2;
        const lumaLength = FLM_LOCAL_OIL_FEATURE_WIDTH * FLM_LOCAL_OIL_FEATURE_HEIGHT;
        const chroma = new Array(chromaLength);
        const luma = new Array(lumaLength);
        const hueHist = new Array(12);
        for (let i = 0; i < chromaLength; i++) chroma[i] = bytes[offset++] / 255;
        for (let i = 0; i < lumaLength; i++) luma[i] = bytes[offset++] / 255;
        for (let i = 0; i < 12; i++) hueHist[i] = bytes[offset++] / 255;
        const saturation = bytes[offset++] / 255;
        const texture = bytes[offset++] / 255;
        return { feature: { chroma, luma, hueHist, saturation, texture }, offset };
    }

    function flmLocalOilDecodeCompanyReferences() {
        const binary = atob(FLM_LOCAL_OIL_COMPANY_DESCRIPTOR_B64_FULL);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const expectedCount = FLM_LOCAL_OIL_COMPANY_GROUPS.reduce((sum, [, count]) => sum + count, 0);
        const bytesPerReference = FLM_LOCAL_OIL_FEATURE_LENGTH * 2 + 1;
        if (bytes.length !== expectedCount * bytesPerReference) {
            throw new Error(`公司包装特征长度异常：${bytes.length}/${expectedCount * bytesPerReference}`);
        }
        const references = [];
        let offset = 0;
        FLM_LOCAL_OIL_COMPANY_GROUPS.forEach(([category, count]) => {
            const label = FLM_LOCAL_OIL_CATEGORY_META[category]?.label || category;
            for (let index = 0; index < count; index++) {
                const whole = flmLocalOilDecodeFeature(bytes, offset);
                offset = whole.offset;
                const labelPart = flmLocalOilDecodeFeature(bytes, offset);
                offset = labelPart.offset;
                const aspect = bytes[offset++] / 255 * 4;
                references.push({
                    id: `company_${category}_${index}`,
                    category,
                    name: `公司资料 ${label} #${index + 1}`,
                    feature: whole.feature,
                    labelFeature: labelPart.feature,
                    aspect: Math.max(0.3, aspect)
                });
            }
        });
        if (offset !== bytes.length || references.length !== expectedCount) throw new Error('公司包装特征解码未完整结束');
        return references;
    }

    async function flmLocalOilPrepareReferenceFeatures(onProgress) {
        if (flmLocalOilReferenceFeatures) return flmLocalOilReferenceFeatures;
        try {
            onProgress?.('正在载入公司产品包装特征（本地，无需联网）…');
            const companyReferences = flmLocalOilDecodeCompanyReferences();
            if (companyReferences.length >= 8) {
                flmLocalOilReferenceFeatures = companyReferences;
                return companyReferences;
            }
        } catch (error) {
            console.warn('[福临门本地识油] 公司包装特征解码失败，改用官方参考图回退：', error);
        }
        const references = await flmLocalOilPrepareReferences(onProgress);
        const features = [];
        for (let i = 0; i < references.length; i++) {
            const reference = references[i];
            try {
                const img = await flmLocalOilLoadImage(reference.dataUrl);
                const canvas = flmLocalOilImageCanvas(img, 180);
                const bounds = flmLocalOilFindProductBounds(canvas);
                features.push({
                    ...reference,
                    feature: flmLocalOilFingerprint(canvas, bounds),
                    labelFeature: flmLocalOilFingerprint(canvas, {
                        x: bounds.x + bounds.width * 0.08,
                        y: bounds.y + bounds.height * 0.18,
                        width: bounds.width * 0.84,
                        height: bounds.height * 0.5
                    }),
                    aspect: bounds.height / Math.max(1, bounds.width)
                });
            } catch (error) {}
        }
        if (features.length < 8) throw new Error('参考包装特征生成失败');
        flmLocalOilReferenceFeatures = features;
        return features;
    }

    function flmLocalOilAnalyzeCanvas(sceneCanvas, references) {
        const width = sceneCanvas.width;
        const height = sceneCanvas.height;
        const scratchCanvas = document.createElement('canvas');
        scratchCanvas.width = 18;
        scratchCanvas.height = 24;
        const scratch = { canvas: scratchCanvas, ctx: scratchCanvas.getContext('2d', { willReadFrequently: true }) };
        const bestByReference = new Map(references.map((reference) => [reference.id, { score: 0, crop: null }]));
        const widthRatios = [0.055, 0.075, 0.1, 0.135];
        const aspects = [1.45, 1.85, 2.25];

        for (const widthRatio of widthRatios) {
            const cropWidth = Math.max(28, Math.min(190, Math.round(width * widthRatio)));
            for (const aspect of aspects) {
                const cropHeight = Math.max(44, Math.min(Math.round(cropWidth * aspect), Math.round(height * 0.48)));
                const stepX = Math.max(18, Math.round(cropWidth * 0.72));
                const stepY = Math.max(22, Math.round(cropHeight * 0.62));
                for (let y = 0; y + cropHeight <= height; y += stepY) {
                    for (let x = 0; x + cropWidth <= width; x += stepX) {
                        const crop = { x, y, width: cropWidth, height: cropHeight };
                        const feature = flmLocalOilFingerprint(sceneCanvas, crop, scratch);
                        if (feature.texture < 0.035 || feature.saturation < 0.08) continue;
                        const labelFeature = flmLocalOilFingerprint(sceneCanvas, {
                            x: crop.x + crop.width * 0.08,
                            y: crop.y + crop.height * 0.18,
                            width: crop.width * 0.84,
                            height: crop.height * 0.5
                        }, scratch);
                        references.forEach((reference) => {
                            if (Math.abs(Math.log((cropHeight / cropWidth) / Math.max(0.3, reference.aspect))) > 0.75) return;
                            // 油液和瓶型高度相似，品类差异主要集中在中上部标签，因此标签权重更高。
                            const similarity = flmLocalOilFeatureSimilarity(feature, reference.feature) * 0.28 +
                                flmLocalOilFeatureSimilarity(labelFeature, reference.labelFeature) * 0.72;
                            const current = bestByReference.get(reference.id);
                            if (similarity > current.score) bestByReference.set(reference.id, { score: similarity, crop });
                        });
                    }
                }
            }
        }

        const categoryScores = {};
        references.forEach((reference) => {
            const match = bestByReference.get(reference.id);
            if (!categoryScores[reference.category]) categoryScores[reference.category] = [];
            categoryScores[reference.category].push({ ...match, referenceId: reference.id, referenceName: reference.name });
        });
        Object.keys(categoryScores).forEach((category) => {
            categoryScores[category].sort((a, b) => b.score - a.score);
        });
        return categoryScores;
    }

    function flmLocalOilMergeImageScores(perImageScores) {
        return Object.keys(FLM_LOCAL_OIL_CATEGORY_META).map((category) => {
            const evidence = [];
            perImageScores.forEach((imageScores, imageIndex) => {
                const matches = imageScores[category] || [];
                if (matches[0]) evidence.push({ ...matches[0], imageIndex });
            });
            evidence.sort((a, b) => b.score - a.score);
            const best = evidence[0] ? evidence[0].score : 0;
            const secondImage = evidence[1] ? evidence[1].score : 0;
            const supportImages = evidence.filter((item) => item.score >= 0.78).length;
            const combined = Math.min(0.98, best * 0.82 + secondImage * 0.18 + Math.min(0.05, Math.max(0, supportImages - 1) * 0.025));
            return {
                category,
                label: FLM_LOCAL_OIL_CATEGORY_META[category].label,
                score: combined,
                supportImages,
                bestReferenceName: evidence[0] ? evidence[0].referenceName : '',
                level: combined >= 0.84 && (supportImages >= 2 || best >= 0.89) ? 'high' : combined >= 0.76 ? 'maybe' : 'low'
            };
        }).sort((a, b) => b.score - a.score);
    }

    function flmLocalOilResultKey(qNum, sources) {
        return `${flmGetCurrentOrderId() || 'unknown'}:${qNum}:${flmLocalOilHash(sources.join('|'))}:${FLM_LOCAL_OIL_REF_VERSION}`;
    }

    function flmLocalOilReadCachedResult(key) {
        if (flmLocalOilRuntimeResults.has(key)) return flmLocalOilRuntimeResults.get(key);
        try {
            const cached = JSON.parse(localStorage.getItem(FLM_LOCAL_OIL_RESULT_PREFIX + flmLocalOilHash(key)) || 'null');
            if (cached && cached.key === key && Date.now() - cached.createdAt < 24 * 60 * 60 * 1000) {
                flmLocalOilRuntimeResults.set(key, cached);
                return cached;
            }
        } catch (error) {}
        return null;
    }

    function flmLocalOilStoreResult(result) {
        flmLocalOilRuntimeResults.set(result.key, result);
        try {
            localStorage.setItem(FLM_LOCAL_OIL_RESULT_PREFIX + flmLocalOilHash(result.key), JSON.stringify(result));
        } catch (error) {}
    }

    async function flmLocalOilRun(qNum, force = false) {
        const sources = flmLocalOilGetOwnEvidenceSources(qNum);
        if (sources.length === 0) {
            autoReviewToast(`${qNum} 没有找到属于本题“照片证据”的图片，未读取审核参考。`, true);
            return;
        }
        const key = flmLocalOilResultKey(qNum, sources);
        if (!force && flmLocalOilReadCachedResult(key)) {
            auditHelperUpdateWorkspace();
            return;
        }
        if (flmLocalOilRunningKey) return;
        flmLocalOilRunningKey = key;
        const setProgress = (message) => {
            flmLocalOilRuntimeResults.set(key, { key, qNum, sources, status: 'running', message, createdAt: Date.now() });
            auditHelperUpdateWorkspace();
        };

        try {
            setProgress('正在准备本地包装特征…');
            const references = await flmLocalOilPrepareReferenceFeatures((done, total) => {
                if (typeof done === 'string') setProgress(done);
                else setProgress(`首次准备官方包装图 ${done}/${total}，以后无需重复下载…`);
            });
            const perImageScores = [];
            const imageErrors = [];
            for (let i = 0; i < sources.length; i++) {
                setProgress(`正在本地扫描 ${qNum} 照片 ${i + 1}/${sources.length}…`);
                try {
                    const blob = await flmLocalOilRequestBlob(sources[i]);
                    const img = await flmLocalOilLoadImage(blob);
                    const canvas = flmLocalOilImageCanvas(img, 1100);
                    perImageScores.push(flmLocalOilAnalyzeCanvas(canvas, references));
                    await new Promise((resolve) => setTimeout(resolve, 0));
                } catch (error) {
                    imageErrors.push(error?.message || String(error));
                    console.warn('[福临门本地识油] 现场照片分析失败:', sources[i], error);
                }
            }
            if (perImageScores.length === 0) {
                const firstError = imageErrors.find(Boolean) || '未知原因';
                throw new Error(`本题 ${sources.length} 张照片均无法读取：${firstError}`);
            }
            const result = {
                key,
                qNum,
                sources,
                status: 'ready',
                createdAt: Date.now(),
                analyzedImages: perImageScores.length,
                categories: flmLocalOilMergeImageScores(perImageScores)
            };
            flmLocalOilStoreResult(result);
            autoReviewToast(`${qNum} 本地识油完成：已分析 ${perImageScores.length} 张本题照片。`);
        } catch (error) {
            flmLocalOilRuntimeResults.set(key, {
                key,
                qNum,
                sources,
                status: 'error',
                message: error.message || '本地识别失败',
                createdAt: Date.now()
            });
            autoReviewToast('本地识油失败：' + (error.message || error), true);
        } finally {
            flmLocalOilRunningKey = '';
            auditHelperUpdateWorkspace();
        }
    }

    function flmLocalOilGetCurrentResult(qNum) {
        const sources = flmLocalOilGetOwnEvidenceSources(qNum);
        if (sources.length === 0) return null;
        return flmLocalOilReadCachedResult(flmLocalOilResultKey(qNum, sources));
    }

    function flmLocalOilFindCategoryForOption(optionText) {
        const text = String(optionText || '').replace(/<[^>]+>/g, '');
        for (const [category, meta] of Object.entries(FLM_LOCAL_OIL_CATEGORY_META)) {
            if (meta.words.some((word) => text.includes(word))) return category;
        }
        return null;
    }

    function flmLocalOilRenderControls(ws, title, qNum) {
        const sources = flmLocalOilGetOwnEvidenceSources(qNum);
        const key = sources.length ? flmLocalOilResultKey(qNum, sources) : '';
        const result = key ? flmLocalOilReadCachedResult(key) : null;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sj-local-oil-btn';
        button.disabled = sources.length === 0 || Boolean(flmLocalOilRunningKey);
        button.textContent = result && result.status === 'ready' ? '↻ 重新本地识油' :
            result && result.status === 'running' ? '识别中…' : `🧭 本地识油 (${sources.length}图)`;
        button.title = `${qNum} 只分析本题左侧“照片证据”，不会读取右侧审核参考，也不会上传图片。`;
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            event.preventDefault();
            flmLocalOilRun(qNum, Boolean(result && result.status === 'ready'));
        });
        title.appendChild(button);

        if (!result) return;
        const panel = document.createElement('div');
        panel.className = 'sj-local-oil-panel';
        if (result.status === 'running' || result.status === 'error') {
            panel.innerHTML = `<div class="sj-local-oil-head"><strong>${result.status === 'error' ? '识别失败' : '本地扫描中'}</strong></div><div class="sj-local-oil-note">${result.message || ''}</div>`;
            ws.appendChild(panel);
            return;
        }

        const q13Card = flmLocalOilGetQuestionCard('Q13');
        const optionStates = {};
        if (q13Card) {
            q13Card.querySelectorAll('.question--option, .question-option, .question.option, .option').forEach((option) => {
                const text = option.textContent.trim();
                const category = flmLocalOilFindCategoryForOption(text);
                if (category) optionStates[category] = {
                    checked: auditHelperIsOptionChecked(option),
                    option
                };
            });
        }
        panel.innerHTML = `<div class="sj-local-oil-head"><strong>${qNum} 本地包装匹配</strong><span>${result.analyzedImages} 张本题照片</span></div><div class="sj-local-oil-note">只作快速候选提示；绿色为较明显，黄色为疑似。右侧审核参考没有参与。</div>`;
        const grid = document.createElement('div');
        grid.className = 'sj-local-oil-grid';
        result.categories.forEach((item) => {
            const row = document.createElement('div');
            row.className = `sj-local-oil-item ${item.level}`;
            const optionState = optionStates[item.category] || null;
            const checked = Boolean(optionState && optionState.checked);
            const mismatch = item.level !== 'low' && !checked;
            const selectedWeak = checked && item.level === 'low';
            row.innerHTML = `<span>${item.label}</span><span class="sj-local-oil-score">${Math.round(item.score * 100)}</span>`;
            const badge = document.createElement('span');
            badge.className = `sj-local-oil-badge ${mismatch ? 'missing' : selectedWeak ? 'weak' : item.level}`;
            badge.textContent = mismatch ? '可能漏选·点此勾选' : selectedWeak ? '已选·当前低匹配' : checked ? '已选择' : item.level === 'high' ? '较明显' : item.level === 'maybe' ? '疑似' : '低匹配';
            badge.title = item.bestReferenceName ? `最接近：${item.bestReferenceName}` : '';
            if (mismatch && optionState && optionState.option) {
                badge.style.cursor = 'pointer';
                badge.addEventListener('click', (event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    const activeDialog = findTargetZoomDialog();
                    if (!activeDialog) return;
                    const optionTextEl = optionState.option.querySelector('.option-title, span') || optionState.option;
                    auditHelperVerifiedQ13Options.add(optionState.option.dataset.sjOriginalText || optionTextEl.innerHTML.trim());
                    auditHelperClickOption(optionState.option, activeDialog);
                    setTimeout(auditHelperUpdateWorkspace, 100);
                    setTimeout(auditHelperUpdateWorkspace, 260);
                });
            }
            row.appendChild(badge);
            grid.appendChild(row);
        });
        panel.appendChild(grid);
        ws.appendChild(panel);
    }

    function auditHelperUpdateWorkspace() {
        const activeDialog = findTargetZoomDialog();
        if (!activeDialog) {
            const ws = document.getElementById('sj-zoom-workspace');
            if (ws) ws.remove();
            activeWSDialogQNum = null;
            activeWSTab = '';
            return;
        }

        const qNum = getActiveDialogQuestionNumber(activeDialog);
        if (!qNum) {
            const ws = document.getElementById('sj-zoom-workspace');
            if (ws) ws.remove();
            return;
        }

        // 如果在输入框处于焦点状态，且没有切换大图和 Tab，则跳过重绘，避免失去焦点
        if (document.activeElement && 
            document.activeElement.classList.contains('sj-ws-fill-input') && 
            activeWSDialogQNum === qNum && 
            activeWSTab) {
            return;
        }

        // 如果切换了放大图的题目卡片，重置 Tab
        if (activeWSDialogQNum !== qNum) {
            activeWSDialogQNum = qNum;
            // Q7 大图默认切到 Q13，Q10 大图也默认切到 Q13
            activeWSTab = 'Q13';
        }

        // 根据放大图片的题号，确定要显示的选项卡列表
        let allowedTabs = [];
        if (qNum === 'Q7') {
            allowedTabs = ['Q8', 'Q9', 'Q13'];
        } else if (qNum === 'Q10') {
            allowedTabs = ['Q12', 'Q13'];
        }

        if (!allowedTabs.includes(activeWSTab)) {
            activeWSTab = allowedTabs.includes('Q13') ? 'Q13' : allowedTabs[0];
        }

        // 查找网页上对应的题目卡片
        let targetCard = null;
        const reviews = document.querySelectorAll('.answer--review');
        for (const review of reviews) {
            const cardInfo = findQuestionCard(review);
            if (cardInfo && cardInfo.qNum === activeWSTab) {
                targetCard = cardInfo.card;
                break;
            }
        }

        if (!targetCard) {
            const ws = document.getElementById('sj-zoom-workspace');
            if (ws) ws.remove();
            return;
        }

        // 插入工作台到放大框内以防止点击拦截
        let ws = document.getElementById('sj-zoom-workspace');
        let oldScrollTop = 0;
        if (ws) {
            const oldList = ws.querySelector('.sj-ws-list');
            if (oldList) {
                oldScrollTop = oldList.scrollTop;
            }
        }

        if (!ws) {
            ws = document.createElement('div');
            ws.id = 'sj-zoom-workspace';
            activeDialog.appendChild(ws);
        } else if (ws.parentElement !== activeDialog) {
            activeDialog.appendChild(ws);
        }

        ws.innerHTML = '';

        // 1. 标题
        const title = document.createElement('div');
        title.className = 'sj-ws-title';
        title.innerHTML = `<span>🔍 ${qNum} 大图联动工作台 (v1.2.1)</span>`;
        ws.appendChild(title);
        flmLocalOilRenderControls(ws, title, qNum);

        // 2. 动态选项卡 Tab 头部
        const tabsContainer = document.createElement('div');
        tabsContainer.className = 'sj-ws-tabs';
        allowedTabs.forEach(tabNum => {
            // 只有当页面上真实存在该题时才渲染该 Tab
            let exists = false;
            for (const review of reviews) {
                const cardInfo = findQuestionCard(review);
                if (cardInfo && cardInfo.qNum === tabNum) {
                    exists = true;
                    break;
                }
            }
            if (!exists) return;

            const tab = document.createElement('div');
            tab.className = `sj-ws-tab ${tabNum === activeWSTab ? 'active' : ''}`;
            tab.textContent = tabNum;
            tab.addEventListener('click', (e) => {
                e.stopPropagation();
                activeWSTab = tabNum;
                auditHelperUpdateWorkspace();
            });
            tabsContainer.appendChild(tab);
        });
        ws.appendChild(tabsContainer);

        // 3. 选项列表容器
        const listContainer = document.createElement('div');
        listContainer.className = 'sj-ws-list';

        const fillInputs = auditHelperGetFillInputs(targetCard);
        if (fillInputs.length > 0 && (activeWSTab === 'Q8' || targetCard.querySelectorAll('.question--option, .question-option, .question.option, .option').length === 0)) {
            auditHelperRenderFillInputs(targetCard, listContainer, activeDialog);
            ws.appendChild(listContainer);
            
            if (oldScrollTop > 0) {
                listContainer.scrollTop = oldScrollTop;
                requestAnimationFrame(() => {
                    listContainer.scrollTop = oldScrollTop;
                });
            }
            return;
        }

        const options = targetCard.querySelectorAll('.question--option, .question-option, .question.option, .option');
        const originalOptions = Array.from(options).filter(el => 
            el.classList.contains('option') || el.classList.contains('question-option') || el.classList.contains('question--option')
        );

        originalOptions.forEach((opt, index) => {
            const isChecked = auditHelperIsOptionChecked(opt);
            const textEl = opt.querySelector('.option-title, span') || opt;
        
            if (!opt.dataset.sjOriginalText) {
                opt.dataset.sjOriginalText = textEl.innerHTML;
            }
            const originalText = opt.dataset.sjOriginalText;

            // 核心高亮
            const keywordsToHighlight = [
                { word: '有物料', color: '#10b981' },
                { word: '无物料', color: '#f56c6c' },
                { word: '有二级货架', color: '#10b981' },
                { word: '没有二级货架', color: '#f56c6c' },
                { word: '福临门', color: '#f59e0b' },
                { word: '有端架', color: '#3b82f6' },
                { word: '有地堆', color: '#8b5cf6' },
                { word: '有促销', color: '#ec4899' }
            ];

            let highlightedText = originalText;
            keywordsToHighlight.forEach(k => {
                const regex = new RegExp(k.word, 'g');
                if (regex.test(highlightedText)) {
                    highlightedText = highlightedText.replace(regex, `<span style="color: ${k.color}; font-weight: bold; border-bottom: 2px solid ${k.color}; padding-bottom: 1px;">$&</span>`);
                }
            });

            const optKey = originalText.trim();
            const isVerified = activeWSTab === 'Q13' && auditHelperVerifiedQ13Options.has(optKey);

            const row = document.createElement('div');
            row.className = `sj-ws-row ${isChecked ? 'checked' : ''} ${isVerified ? 'verified' : ''} ${activeWSTab === 'Q13' && isChecked && !isVerified ? 'pending' : ''}`;

            const icon = document.createElement('div');
            icon.className = `sj-ws-icon ${isChecked ? 'checked' : ''}`;
        
            const titleEl = targetCard.querySelector('.question-title, header, h4, h3');
            const isMultiple = titleEl && titleEl.textContent.includes('多选');
            if (isMultiple) {
                icon.innerHTML = isChecked ? '✓' : '';
                icon.style.borderRadius = '4px';
            } else {
                icon.innerHTML = isChecked ? '●' : '';
                icon.style.borderRadius = '50%';
            }

            const label = document.createElement('div');
            label.className = 'sj-ws-label';
            label.innerHTML = highlightedText;

            row.appendChild(icon);
            row.appendChild(label);

            // 只有当网页上勾选了此选项时，才显示核对进度按钮，极大地净化界面
            if (activeWSTab === 'Q13' && isChecked) {
                const verifyBtn = document.createElement('button');
                verifyBtn.type = 'button';
                verifyBtn.className = `sj-ws-verify-btn ${isVerified ? 'verified' : 'pending'}`;
                verifyBtn.textContent = isVerified ? '已核' : '待核';
                verifyBtn.title = isVerified ? '点击标记为待核' : '点击标记为已核';
                verifyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    if (auditHelperVerifiedQ13Options.has(optKey)) {
                        auditHelperVerifiedQ13Options.delete(optKey);
                    } else {
                        auditHelperVerifiedQ13Options.add(optKey);
                    }
                    auditHelperUpdateWorkspace();
                });
                row.appendChild(verifyBtn);
            }

            row.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                row.classList.toggle('checked');
                icon.classList.toggle('checked');
                icon.innerHTML = icon.classList.contains('checked') ? (isMultiple ? '&check;' : '&#9679;') : '';
            
                if (activeWSTab === 'Q13') {
                    if (!isChecked) {
                        auditHelperVerifiedQ13Options.add(optKey);
                    } else {
                        auditHelperVerifiedQ13Options.delete(optKey);
                    }
                }

                // 使用通用模拟背景点击函数
                auditHelperClickOption(opt, activeDialog);
            
                setTimeout(auditHelperUpdateWorkspace, 80);
                setTimeout(auditHelperUpdateWorkspace, 220);
            });

            listContainer.appendChild(row);
        });

        ws.appendChild(listContainer);

        if (oldScrollTop > 0) {
            listContainer.scrollTop = oldScrollTop;
            requestAnimationFrame(() => {
                listContainer.scrollTop = oldScrollTop;
            });
        }
    }

    let flmHelperStarted = false;
    const startHelper = () => {
        if (flmHelperStarted || !document.body) return;
        flmHelperStarted = true;
        // 不再等待所有图片触发 window.load；DOM 可用后立即启动预取、审核拦截和图片优化。
        flmInitFastAuditInterceptor();
        flmInitImageOptimizer();
        init();
        startBackgroundRefresh();
        setInterval(init, 2000);

        let sjDragFromWorkspace = false;
        let sjBlockNextClick = false;

        // 监听 mousedown，如果是在工作台内部开始的，标记为正在拖拽
        document.addEventListener('mousedown', (e) => {
            const ws = document.getElementById('sj-zoom-workspace');
            if (ws && ws.contains(e.target)) {
                sjDragFromWorkspace = true;
            } else {
                sjDragFromWorkspace = false;
            }
        }, true);

        // 监听 mouseup，如果拖拽是从工作台开始的，且释放在工作台外部，则阻止冒泡和默认行为，防止触发模态框关闭
        document.addEventListener('mouseup', (e) => {
            if (sjDragFromWorkspace) {
                sjDragFromWorkspace = false;
                const ws = document.getElementById('sj-zoom-workspace');
                if (ws && !ws.contains(e.target)) {
                    e.stopPropagation();
                    e.preventDefault();
                    sjBlockNextClick = true;
                    setTimeout(() => { sjBlockNextClick = false; }, 50);
                }
            }
        }, true);

        // 监听全局点击事件，以在打开/关闭大图时瞬间响应工作台更新（消除 2 秒轮询的延迟）
        document.addEventListener('click', (e) => {
            if (sjBlockNextClick) {
                e.stopPropagation();
                e.preventDefault();
                sjBlockNextClick = false;
                return;
            }
            setTimeout(auditHelperUpdateWorkspace, 100);
            setTimeout(auditHelperUpdateWorkspace, 300);
        }, true);

        // 监听DOM变化，使图片编辑快捷按钮秒开秒关以及复制Q5照片证据到Q6
        const observer = new MutationObserver(() => {
            if (typeof photoEditEnsureShortcutButton === 'function') {
                photoEditEnsureShortcutButton();
            }
            if (typeof cloneQ5EvidenceToQ6 === 'function') {
                cloneQ5EvidenceToQ6();
            }
            if (typeof ensureQ6QuickFailButton === 'function') {
                ensureQ6QuickFailButton();
            }
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class']
        });
    };

    // document-start 阶段先安装图片拦截，避免网站已经发出原图请求后才开始优化。
    flmInitImageOptimizer();
    if (FLM_IS_WARM_FRAME) return;

    // Speculation Rules 会在后台创建一个顶层预渲染文档。预渲染期间只能预热页面和图片，
    // 不能启动插件主体，否则会提前执行“预取下一单”，造成无意中多领取一个订单。
    const startActiveDocumentHelper = () => {
        // 如果网站审核回调曾把导航覆盖回原订单，优先恢复刚才的预存订单跳转。
        if (flmRecoverPendingNavigation()) return;
        flmInitFastAuditInterceptor();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startHelper, { once: true });
        } else {
            startHelper();
        }
    };

    if (document.prerendering) {
        document.addEventListener('prerenderingchange', startActiveDocumentHelper, { once: true });
        return;
    }

    startActiveDocumentHelper();
})();
