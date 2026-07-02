// ==UserScript==
// @name         爱零工审单数据助手福临门
// @namespace    http://tampermonkey.net/
// @version      1.1.9
// @description  统计每日及每小时审核订单量，支持日期切换。内置一键通过审核助手（Alt+A）及题目折叠功能（福临门专版）。
// @author       Antigravity
// @match        *://admin2.slicejobs.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/echarts/5.4.3/echarts.min.js
// @require      https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(/* @global echarts */ function() {
    'use strict';

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
            width: 330px;
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
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .sj-ws-row {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            padding: 10px 12px;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid rgba(255, 255, 255, 0.04);
            cursor: pointer;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            user-select: none;
        }
        .sj-ws-row:hover {
            background: rgba(255, 255, 255, 0.06);
            border-color: rgba(255, 255, 255, 0.08);
        }
        .sj-ws-row.checked {
            border-color: rgba(16, 185, 129, 0.3);
            background: rgba(16, 185, 129, 0.05);
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
            margin-top: 1px;
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
            line-height: 1.4;
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
            (b) => b.textContent.trim() === '审核下一单'
        );
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
            autoReviewClickEl(confirmBtn);

            // 等待跳转下一单按钮出现
            let nextBtn = null;
            for (let i = 0; i < 40; i++) { // 40 * 150ms = 6s
                nextBtn = autoReviewGetNextOrderButton();
                if (nextBtn) break;
                await autoReviewSleep(150);
            }

            // ③ 去掉固定 400ms，检测到按钮存在直接跳转
            nextBtn = autoReviewGetNextOrderButton();
            if (nextBtn) {
                autoReviewToast('审核已提交，正在跳转下一单...');
                autoReviewClickEl(nextBtn);
            } else {
                autoReviewToast('审核可能已提交，但未找到"审核下一单"按钮，请手动确认', true);
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
            return;
        }
        photoEditEnsureShortcutButton();

        // 直接同步检测题目面板是否存在且一键通过按钮尚未渲染，满足才创建
            if (reviewLastLocationHref !== location.href) {
                reviewLastLocationHref = location.href;
                manuallyExpandedQuestions.clear();
                q22SelectedForCurrentOrder = false;
            }
        if (document.querySelector('.answer--review')) {
            if (!document.getElementById('sj-auto-review-btn')) {
                autoReviewCreatePanel();
            }
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
        title.innerHTML = `<span>🔍 ${qNum} 大图联动工作台 (v1.1.9)</span>`;
        ws.appendChild(title);

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
        if (fillInputs.length > 0 && (activeWSTab === 'Q8' || activeWSTab === 'Q12' || targetCard.querySelectorAll('.question--option, .question-option, .question.option, .option').length === 0)) {
            auditHelperRenderFillInputs(targetCard, listContainer, activeDialog);
            ws.appendChild(listContainer);
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

            const row = document.createElement('div');
            row.className = `sj-ws-row ${isChecked ? 'checked' : ''}`;

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

            row.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                row.classList.toggle('checked');
                icon.classList.toggle('checked');
                icon.innerHTML = icon.classList.contains('checked') ? (isMultiple ? '&check;' : '&#9679;') : '';
            
                // 使用通用模拟背景点击函数
                auditHelperClickOption(opt, activeDialog);
            
                setTimeout(auditHelperUpdateWorkspace, 80);
                setTimeout(auditHelperUpdateWorkspace, 220);
            });

            listContainer.appendChild(row);
        });

        ws.appendChild(listContainer);
    }

    const startHelper = () => {
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

    if (document.readyState === 'complete') {
        startHelper();
    } else {
        window.addEventListener('load', startHelper);
    }
})();
