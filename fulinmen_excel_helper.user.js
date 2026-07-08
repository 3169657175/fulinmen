// ==UserScript==
// @name         爱零工审单数据助手-福临门排面对账版
// @namespace    http://tampermonkey.net/
// @version      1.1.4
// @description  上传 Excel 文件进行排队对账，支持自动定位、直接修改内存数据并导出新 Excel。
// @author       Antigravity
// @match        *://admin2.slicejobs.com/*
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // 默认键名变量，自动识别 Excel 列名
    let orderIdKey = "工单ID";
    let handlerKey = "处理人";
    let totalFacingKey = "【主货架排面】所有品牌食用油主货架排面数";
    let flmFacingKey = "【主货架排面】福临门品牌食用油主货架排面数";

    // 独立记录 Excel 助手折叠过的卡片状态
    const manuallyExpandedQuestionsExcel = new Set();

    // 识别与绑定 Excel 属性名
    function identifyKeys(firstRow) {
        if (!firstRow) return;
        for (let key in firstRow) {
            const lowerKey = key.toLowerCase();
            if (lowerKey.includes("工单id") || lowerKey.includes("工单号")) {
                orderIdKey = key;
            } else if (lowerKey.includes("处理人") || lowerKey.includes("审核员")) {
                handlerKey = key;
            } else if (lowerKey.includes("所有品牌") && lowerKey.includes("主货架排面")) {
                totalFacingKey = key;
            } else if (lowerKey.includes("福临门") && lowerKey.includes("主货架排面")) {
                flmFacingKey = key;
            }
        }
    }

    // 从本地缓存读取和保存 Excel 的行数据 (读取时动态识别列名，防止本地缓存污染)
    function getStoredRows() {
        const json = GM_getValue('sj_excel_rows', '[]');
        try {
            const rows = JSON.parse(json);
            if (rows.length > 0) {
                identifyKeys(rows[0]);
            }
            return rows;
        } catch (e) {
            return [];
        }
    }

    function saveRows(rows) {
        GM_setValue('sj_excel_rows', JSON.stringify(rows));
    }

    // 样式注入
    GM_addStyle(`
        #sj-excel-panel {
            position: fixed;
            right: 20px;
            top: 140px;
            width: 280px;
            z-index: 200000;
            background: rgba(15, 23, 42, 0.95);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
            font-family: system-ui, sans-serif;
            color: #e2e8f0;
            padding: 16px;
            user-select: none;
            backdrop-filter: blur(10px);
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }
        #sj-excel-panel.collapsed {
            width: 48px;
            height: 48px;
            padding: 0;
            overflow: hidden;
            border-radius: 50%;
            background: #10b981;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        #sj-excel-panel.collapsed * {
            display: none;
        }
        #sj-excel-panel.collapsed::after {
            content: "📊";
            font-size: 20px;
            display: block;
        }
        .sj-excel-title {
            font-size: 14px;
            font-weight: 700;
            margin-bottom: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            color: #10b981;
        }
        .sj-excel-close {
            cursor: pointer;
            color: #94a3b8;
            font-size: 14px;
        }
        .sj-excel-close:hover {
            color: #f1f5f9;
        }
        .sj-btn {
            display: block;
            width: 100%;
            padding: 8px 12px;
            margin-bottom: 10px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #f8fafc;
            border-radius: 8px;
            cursor: pointer;
            font-size: 13px;
            text-align: center;
            font-weight: 600;
            transition: all 0.2s;
        }
        .sj-btn:hover {
            background: #10b981;
            border-color: #10b981;
            color: #fff;
        }
        .sj-excel-select {
            width: 100%;
            padding: 8px 10px;
            margin-bottom: 14px;
            background: #1e293b;
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #f1f5f9;
            border-radius: 8px;
            outline: none;
            font-size: 12px;
        }
        /* 顶部导航控制条 */
        #sj-excel-navbar {
            position: fixed;
            top: 10px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 200000;
            background: rgba(15, 23, 42, 0.95);
            border: 1px solid rgba(16, 185, 129, 0.35);
            border-radius: 30px;
            padding: 6px 18px;
            display: flex;
            align-items: center;
            gap: 12px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
            font-family: system-ui, sans-serif;
            font-size: 13px;
            color: #e2e8f0;
            backdrop-filter: blur(8px);
        }
        .sj-nav-btn {
            background: rgba(16, 185, 129, 0.15);
            border: 1px solid rgba(16, 185, 129, 0.4);
            color: #34d399;
            border-radius: 20px;
            padding: 4px 12px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            transition: all 0.2s;
        }
        .sj-nav-btn:hover {
            background: #10b981;
            color: white;
            border-color: #10b981;
        }
        .sj-nav-progress {
            font-weight: 500;
            color: #94a3b8;
        }
        .sj-nav-facings-wrapper {
            display: flex;
            align-items: center;
            gap: 10px;
            border-left: 1px solid rgba(255, 255, 255, 0.15);
            border-right: 1px solid rgba(255, 255, 255, 0.15);
            padding: 0 14px;
            margin: 0 2px;
        }
        .sj-nav-field {
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .sj-nav-input {
            width: 44px;
            background: #1e293b;
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 4px;
            color: #f1f5f9;
            padding: 2px 4px;
            text-align: center;
            font-weight: bold;
            font-size: 13px;
            outline: none;
        }
        .sj-nav-input:focus {
            border-color: #10b981;
        }
        /* 题目上方数据比对卡 */
        .sj-comparison-card {
            margin: 10px 0;
            padding: 12px 16px;
            background: rgba(16, 185, 129, 0.05);
            border: 1px solid rgba(16, 185, 129, 0.22);
            border-radius: 8px;
            display: flex;
            align-items: center;
            gap: 16px;
            font-family: system-ui, sans-serif;
        }
        .sj-comparison-title {
            font-size: 13px;
            font-weight: 700;
            color: #34d399;
        }
        .sj-comparison-field {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            color: #cbd5e1;
        }
        .sj-comparison-input {
            width: 50px;
            background: #1e293b;
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 4px;
            color: #f1f5f9;
            padding: 2px 6px;
            text-align: center;
            font-weight: bold;
            font-size: 13px;
            outline: none;
        }
        .sj-comparison-input:focus {
            border-color: #10b981;
        }
        /* 对账版专属折叠卡片样式（不影响原插件样式名） */
        .sj-excel-collapsed-card {
            height: 38px !important;
            overflow: hidden !important;
            opacity: 0.65;
            position: relative;
            border: 1px dashed #dcdfe6 !important;
            background-color: #f5f7fa !important;
            transition: all 0.2s ease-in-out;
        }
        .sj-excel-collapsed-card:hover {
            opacity: 1;
            background-color: #ecf5ff !important;
            border-color: #c6e2ff !important;
        }
        .sj-excel-collapsed-card * {
            pointer-events: none !important;
        }
        .sj-excel-collapsed-card .sj-excel-collapse-toggle-btn {
            pointer-events: auto !important;
        }
        /* 拦截说明信息的高频弹窗 */
        .question-detail-text.el-popover__reference,
        .question-detail-text,
        .question-detail {
            pointer-events: none !important;
            user-select: none !important;
        }
    `);

    // 获取当前工单 ID
    function getOrderFromUrl() {
        const match = window.location.href.match(/\/order\/review\/(\d+)/);
        return match ? match[1] : null;
    }

    // 筛选当前处理人的所有工单列表 (保持原有 Excel 物理行顺序排列)
    function getActiveQueue() {
        const handler = GM_getValue('sj_excel_handler', '');
        const rows = getStoredRows();
        if (!handler || rows.length === 0) return [];
        return rows.filter(row => String(row[handlerKey]) === handler);
    }

    // 标记当前工单为“已看过”
    function markCurrentOrderAsViewed() {
        const currentId = getOrderFromUrl();
        if (!currentId) return;
        const rows = getStoredRows();
        let updated = false;
        for (let row of rows) {
            if (String(row[orderIdKey]) === currentId) {
                if (row["是否看过"] !== "是") {
                    row["是否看过"] = "是";
                    updated = true;
                }
                break;
            }
        }
        if (updated) {
            saveRows(rows);
            updateNavbarProgress();
        }
    }

    // 创建侧边配置面板
    function createConfigPanel() {
        if (document.getElementById('sj-excel-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'sj-excel-panel';
        panel.className = GM_getValue('sj_excel_panel_collapsed', false) ? 'collapsed' : '';
        
        // 展开与折叠控制
        panel.addEventListener('click', (e) => {
            if (panel.classList.contains('collapsed')) {
                panel.classList.remove('collapsed');
                GM_setValue('sj_excel_panel_collapsed', false);
            }
        });

        const title = document.createElement('div');
        title.className = 'sj-excel-title';
        title.innerHTML = `<span>📊 福临门 Excel 联动对账</span>`;
        
        const closeBtn = document.createElement('span');
        closeBtn.className = 'sj-excel-close';
        closeBtn.textContent = '❌';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            panel.classList.add('collapsed');
            GM_setValue('sj_excel_panel_collapsed', true);
        });
        title.appendChild(closeBtn);
        panel.appendChild(title);

        // 上传按钮
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.xlsx';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', handleFileUpload);
        panel.appendChild(fileInput);

        const uploadBtn = document.createElement('button');
        uploadBtn.className = 'sj-btn';
        uploadBtn.textContent = '📂 导入 Excel 数据';
        uploadBtn.addEventListener('click', () => fileInput.click());
        panel.appendChild(uploadBtn);

        // 处理人下拉筛选
        const selectLabel = document.createElement('div');
        selectLabel.style.fontSize = '12px';
        selectLabel.style.color = '#94a3b8';
        selectLabel.style.marginBottom = '6px';
        selectLabel.textContent = '👤 选择您的处理人名字：';
        panel.appendChild(selectLabel);

        const select = document.createElement('select');
        select.className = 'sj-excel-select';
        select.id = 'sj-excel-auditor-select';
        select.addEventListener('change', (e) => {
            GM_setValue('sj_excel_handler', e.target.value);
            updateNavbarProgress();
        });
        panel.appendChild(select);

        // 导出按钮
        const exportBtn = document.createElement('button');
        exportBtn.className = 'sj-btn';
        exportBtn.style.background = 'rgba(16, 185, 129, 0.15)';
        exportBtn.style.borderColor = 'rgba(16, 185, 129, 0.4)';
        exportBtn.style.color = '#34d399';
        exportBtn.textContent = '💾 导出更新后的 Excel';
        exportBtn.addEventListener('click', handleExportExcel);
        panel.appendChild(exportBtn);

        document.body.appendChild(panel);
        updateAuditorDropdown();
    }

    // 更新处理人下拉列表
    function updateAuditorDropdown() {
        const select = document.getElementById('sj-excel-auditor-select');
        if (!select) return;

        const rows = getStoredRows();
        const handlerSet = new Set();
        rows.forEach(row => {
            if (row[handlerKey]) handlerSet.add(row[handlerKey]);
        });

        select.innerHTML = '';
        
        // 如果数据为空
        if (handlerSet.size === 0) {
            const opt = document.createElement('option');
            opt.textContent = '-- 请先导入数据 --';
            select.appendChild(opt);
            return;
        }

        const sortedHandlers = Array.from(handlerSet).sort();
        sortedHandlers.forEach(h => {
            const opt = document.createElement('option');
            opt.value = h;
            opt.textContent = h;
            select.appendChild(opt);
        });

        // 默认恢复已选处理人，如果没有，默认匹配含有“牛昊文”的选项
        let storedHandler = GM_getValue('sj_excel_handler', '');
        if (!storedHandler || !handlerSet.has(storedHandler)) {
            storedHandler = sortedHandlers.find(h => h.includes('牛昊文')) || sortedHandlers[0];
            GM_setValue('sj_excel_handler', storedHandler);
        }
        select.value = storedHandler;
    }

    // 上传文件解析
    function handleFileUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        GM_setValue('sj_excel_filename', file.name);

        const reader = new FileReader();
        reader.onload = function(evt) {
            try {
                const data = new Uint8Array(evt.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const sheetName = workbook.SheetNames[0];
                const sheet = workbook.Sheets[sheetName];

                // 备份表头顺序
                const range = XLSX.utils.decode_range(sheet['!ref']);
                const headers = [];
                for (let C = range.s.c; C <= range.e.c; ++C) {
                    const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: C })];
                    headers.push(cell ? cell.v : "");
                }
                GM_setValue('sj_excel_headers', JSON.stringify(headers));

                // 转换 JSON
                const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
                if (rows.length > 0) {
                    identifyKeys(rows[0]);
                    
                    // 补全“是否看过”标记
                    rows.forEach(row => {
                        if (!row["是否看过"]) {
                            row["是否看过"] = (row[totalFacingKey] !== "" && parseInt(row[totalFacingKey], 10) > 0) ? "是" : "否";
                        }
                    });

                    saveRows(rows);
                    updateAuditorDropdown();
                    updateNavbarProgress();
                    alert(`🎉 成功解析并导入 ${rows.length} 行数据！`);
                    location.reload();
                } else {
                    alert("⚠️ 表格数据为空！");
                }
            } catch (err) {
                console.error(err);
                alert("❌ Excel 解析失败: " + err.message);
            }
        };
        reader.readAsArrayBuffer(file);
    }

    // 导出 Excel
    function handleExportExcel() {
        const rows = getStoredRows();
        if (rows.length === 0) {
            alert("⚠️ 没有可导出的数据！");
            return;
        }

        const headersJson = GM_getValue('sj_excel_headers', '[]');
        let headers = [];
        try {
            headers = JSON.parse(headersJson);
        } catch (e) {}

        // 复制行并彻底移除“是否看过”列，防止污染导出的 Excel 结构
        const exportRows = rows.map(row => {
            const newRow = { ...row };
            delete newRow["是否看过"];
            return newRow;
        });

        // 确保表头中没有“是否看过”列
        headers = headers.filter(h => h !== "是否看过");

        try {
            const newSheet = XLSX.utils.json_to_sheet(exportRows, { header: headers });
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, newSheet, "Sheet1");

            const filename = GM_getValue('sj_excel_filename', 'fulinmen_export.xlsx');
            XLSX.writeFile(workbook, filename);
        } catch (err) {
            console.error(err);
            alert("❌ 导出失败: " + err.message);
        }
    }

    // 刷新和构建顶部导航条
    function updateNavbarProgress() {
        const queue = getActiveQueue();
        if (queue.length === 0) {
            const bar = document.getElementById('sj-excel-navbar');
            if (bar) bar.remove();
            return;
        }

        let bar = document.getElementById('sj-excel-navbar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'sj-excel-navbar';
            document.body.appendChild(bar);
        }

        const currentId = getOrderFromUrl();
        const handler = GM_getValue('sj_excel_handler', '');

        // 计算进度
        const total = queue.length;
        const viewed = queue.filter(r => r["是否看过"] === "是").length;

        // 寻找当前工单在队列中的索引
        let currentIndex = -1;
        for (let i = 0; i < queue.length; i++) {
            if (String(queue[i][orderIdKey]) === currentId) {
                currentIndex = i;
                break;
            }
        }

        // 上一单和下一单直接在物理行队列中进行加减（不跳过已看过，保证顺序 100% 正确）
        let prevId = (currentIndex > 0) ? queue[currentIndex - 1][orderIdKey] : null;
        let nextId = (currentIndex >= 0 && currentIndex < queue.length - 1) ? queue[currentIndex + 1][orderIdKey] : null;

        // 读取当前订单的值，用于顶部导航比对
        const targetRow = queue.find(row => String(row[orderIdKey]) === currentId);
        const totalVal = targetRow ? (targetRow[totalFacingKey] !== undefined && targetRow[totalFacingKey] !== null ? targetRow[totalFacingKey] : "") : "";
        const flmVal = targetRow ? (targetRow[flmFacingKey] !== undefined && targetRow[flmFacingKey] !== null ? targetRow[flmFacingKey] : "") : "";

        bar.innerHTML = '';

        // 1. 上一单按钮
        const prevBtn = document.createElement('button');
        prevBtn.className = 'sj-nav-btn';
        prevBtn.textContent = '⬅️ 上一单';
        if (prevId) {
            prevBtn.addEventListener('click', () => {
                GM_setValue('sj_excel_autofocus_q10', true);
                window.location.href = `/order/review/${prevId}`;
            });
        } else {
            prevBtn.style.opacity = '0.5';
            prevBtn.style.cursor = 'not-allowed';
        }
        bar.appendChild(prevBtn);

        // 2. 进度文本
        const progress = document.createElement('span');
        progress.className = 'sj-nav-progress';
        progress.textContent = `👤 ${handler} (${viewed}/${total})`;
        bar.appendChild(progress);

        // 3. 📊 数据比对输入框挂载在顶部 Navbar，最省眼！
        if (targetRow) {
            const navCmp = document.createElement('div');
            navCmp.className = 'sj-nav-facings-wrapper';
            navCmp.innerHTML = `
                <div class="sj-nav-field">
                    <span style="color: #60a5fa;">总排面:</span>
                    <input type="number" class="sj-nav-input" id="sj-nav-total-facing" value="${totalVal}">
                </div>
                <div class="sj-nav-field">
                    <span style="color: #f87171;">福临门:</span>
                    <input type="number" class="sj-nav-input" id="sj-nav-flm-facing" value="${flmVal}">
                </div>
            `;

            // 同步写回数据
            const totalInput = navCmp.querySelector('#sj-nav-total-facing');
            totalInput.addEventListener('input', (e) => {
                const rows = getStoredRows();
                const matched = rows.find(r => String(r[orderIdKey]) === currentId);
                if (matched) {
                    matched[totalFacingKey] = e.target.value;
                    saveRows(rows);
                    // 同步到 Q10 题目卡片
                    const q10Input = document.getElementById('sj-q10-total-input');
                    if (q10Input) q10Input.value = e.target.value;
                }
            });

            const flmInput = navCmp.querySelector('#sj-nav-flm-facing');
            flmInput.addEventListener('input', (e) => {
                const rows = getStoredRows();
                const matched = rows.find(r => String(r[orderIdKey]) === currentId);
                if (matched) {
                    matched[flmFacingKey] = e.target.value;
                    saveRows(rows);
                    // 同步到 Q10 题目卡片
                    const q10Input = document.getElementById('sj-q10-flm-input');
                    if (q10Input) q10Input.value = e.target.value;
                }
            });

            bar.appendChild(navCmp);
        }

        // 4. 下一单按钮
        const nextBtn = document.createElement('button');
        nextBtn.className = 'sj-nav-btn';
        nextBtn.textContent = '下一单 ➡️';
        if (nextId) {
            nextBtn.addEventListener('click', () => {
                GM_setValue('sj_excel_autofocus_q10', true);
                window.location.href = `/order/review/${nextId}`;
            });
        } else {
            nextBtn.style.opacity = '0.5';
            nextBtn.style.cursor = 'not-allowed';
        }
        bar.appendChild(nextBtn);
    }

    // 自动寻找并向 Q10 题目卡片注入比对输入框
    function injectComparisonUI() {
        const currentId = getOrderFromUrl();
        if (!currentId) return;

        const rows = getStoredRows();
        const targetRow = rows.find(row => String(row[orderIdKey]) === currentId);
        if (!targetRow) return;

        // 寻找第十题卡片 Q10 (模糊匹配标题)
        const q10Card = Array.from(document.querySelectorAll('.question-card, .question, [class*="card"]')).find(card => {
            const titleEl = card.querySelector('.question-title, header, h4, h3, .title');
            if (titleEl) {
                const text = titleEl.textContent;
                return text.includes('Q10') || text.includes('第10题') || text.includes('10.');
            }
            return card.textContent.includes('Q10') || card.textContent.includes('第十题');
        });

        if (!q10Card || q10Card.querySelector('.sj-comparison-card')) return;

        // 创建比对卡
        const cmpCard = document.createElement('div');
        cmpCard.className = 'sj-comparison-card';

        const title = document.createElement('div');
        title.className = 'sj-comparison-title';
        title.textContent = '📊 表格预设数据对账：';
        cmpCard.appendChild(title);

        const totalVal = targetRow[totalFacingKey] !== undefined && targetRow[totalFacingKey] !== null ? targetRow[totalFacingKey] : "";
        const flmVal = targetRow[flmFacingKey] !== undefined && targetRow[flmFacingKey] !== null ? targetRow[flmFacingKey] : "";

        // 1. 总排面输入框
        const totalDiv = document.createElement('div');
        totalDiv.className = 'sj-comparison-field';
        totalDiv.innerHTML = `<span>总排面数:</span>`;
        const totalInput = document.createElement('input');
        totalInput.className = 'sj-comparison-input';
        totalInput.id = 'sj-q10-total-input';
        totalInput.type = 'number';
        totalInput.value = totalVal;
        totalInput.addEventListener('input', (e) => {
            targetRow[totalFacingKey] = e.target.value;
            saveRows(rows);
            // 同步顶部 navbar
            const navTotal = document.getElementById('sj-nav-total-facing');
            if (navTotal) navTotal.value = e.target.value;
        });
        totalDiv.appendChild(totalInput);
        cmpCard.appendChild(totalDiv);

        // 2. 福临门排面输入框
        const flmDiv = document.createElement('div');
        flmDiv.className = 'sj-comparison-field';
        flmDiv.innerHTML = `<span>福临门排面:</span>`;
        const flmInput = document.createElement('input');
        flmInput.className = 'sj-comparison-input';
        flmInput.id = 'sj-q10-flm-input';
        flmInput.type = 'number';
        flmInput.value = flmVal;
        flmInput.addEventListener('input', (e) => {
            targetRow[flmFacingKey] = e.target.value;
            saveRows(rows);
            // 同步顶部 navbar
            const navFlm = document.getElementById('sj-nav-flm-facing');
            if (navFlm) navFlm.value = e.target.value;
        });
        flmDiv.appendChild(flmInput);
        cmpCard.appendChild(flmDiv);

        // 注入到 Q10 题目标题下方
        const insertTarget = q10Card.querySelector('.question-title, header, h4, h3, .title') || q10Card.firstChild;
        if (insertTarget.nextSibling) {
            q10Card.insertBefore(cmpCard, insertTarget.nextSibling);
        } else {
            q10Card.appendChild(cmpCard);
        }
    }

    // 复刻原版折叠的核心辅助逻辑
    function findQuestionCard(reviewEl) {
        let current = reviewEl;
        while (current) {
            if (current.classList.contains('question-card') || current.classList.contains('question') || current.className.includes('card')) {
                const titleEl = current.querySelector('.question-title, header, h4, h3, .title');
                if (titleEl) {
                    const text = titleEl.textContent;
                    const match = text.match(/Q\d+/);
                    const qNum = match ? match[0] : null;
                    return { card: current, qNum, titleEl };
                }
            }
            current = current.parentElement;
        }
        return null;
    }

    // 复刻原版折叠逻辑：除了 Q7 和 Q10 外的 1-22 所有题目全部默认折叠，且支持点【展开/收起】按钮交互
    function excelHelperCollapseUnneeded() {
        const collapseNums = new Set([
            'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q8', 'Q9', 
            'Q11', 'Q12', 'Q13', 'Q14', 'Q15', 'Q16', 'Q17', 
            'Q18', 'Q19', 'Q20', 'Q21', 'Q22'
        ]);
        const reviews = document.querySelectorAll('.answer--review');
        if (reviews.length === 0) return;

        reviews.forEach((review) => {
            const cardInfo = findQuestionCard(review);
            if (!cardInfo) return;

            const { card, qNum, titleEl } = cardInfo;
            if (!qNum) return;

            const shouldCollapse = collapseNums.has(qNum) && !manuallyExpandedQuestionsExcel.has(qNum);

            if (!card.dataset.sjExcelCollapseBound) {
                card.dataset.sjExcelCollapseBound = 'true';
                card.addEventListener('click', (e) => {
                    const toggleBtn = card.querySelector('.sj-excel-collapse-toggle-btn');
                    if (card.classList.contains('sj-excel-collapsed-card')) {
                        card.classList.remove('sj-excel-collapsed-card');
                        manuallyExpandedQuestionsExcel.add(qNum);
                        if (toggleBtn) toggleBtn.textContent = ' 收起';
                        e.stopPropagation();
                        e.preventDefault();
                    } else if (e.target.classList.contains('sj-excel-collapse-toggle-btn')) {
                        card.classList.add('sj-excel-collapsed-card');
                        manuallyExpandedQuestionsExcel.delete(qNum);
                        if (toggleBtn) toggleBtn.textContent = ' 展开';
                        e.stopPropagation();
                        e.preventDefault();
                    }
                });
            }

            let toggleBtn = card.querySelector('.sj-excel-collapse-toggle-btn');
            if (collapseNums.has(qNum) && !toggleBtn) {
                toggleBtn = document.createElement('span');
                toggleBtn.className = 'sj-excel-collapse-toggle-btn';
                toggleBtn.style.color = '#3b82f6';
                toggleBtn.style.marginLeft = '10px';
                toggleBtn.style.cursor = 'pointer';
                toggleBtn.style.fontWeight = 'bold';
                titleEl.appendChild(toggleBtn);
            }

            if (shouldCollapse) {
                card.classList.add('sj-excel-collapsed-card');
                if (toggleBtn) toggleBtn.textContent = ' 展开';
            } else {
                card.classList.remove('sj-excel-collapsed-card');
                if (toggleBtn) toggleBtn.textContent = collapseNums.has(qNum) ? ' 收起' : '';
            }
        });
    }

    // 自动定位和展开大图逻辑
    function handleAutofocus() {
        const isFocusNeeded = GM_getValue('sj_excel_autofocus_q10', false);
        if (!isFocusNeeded) return;

        // 定时轮询等待 Q10 卡片渲染完成
        let attempts = 0;
        const interval = setInterval(() => {
            attempts++;
            const q10Card = Array.from(document.querySelectorAll('.question-card, .question, [class*="card"]')).find(card => {
                const titleEl = card.querySelector('.question-title, header, h4, h3, .title');
                if (titleEl) {
                    const text = titleEl.textContent;
                    return text.includes('Q10') || text.includes('第10题') || text.includes('10.');
                }
                return card.textContent.includes('Q10') || card.textContent.includes('第十题');
            });

            if (q10Card) {
                clearInterval(interval);
                GM_setValue('sj_excel_autofocus_q10', false); // 消费标志位

                // 1. 自动滚屏
                q10Card.scrollIntoView({ behavior: 'smooth', block: 'center' });

                // 2. 如果卡片折叠了，自动展开
                const expandBtn = q10Card.querySelector('.el-collapse-item__header, [class*="expand"], [class*="arrow"]');
                if (expandBtn && expandBtn.getAttribute('aria-expanded') !== 'true') {
                    expandBtn.click();
                }

                // 3. 自动点开第一张证据图
                setTimeout(() => {
                    const titleEl = Array.from(q10Card.querySelectorAll('*')).find(el => {
                        if (el.children.length > 0) return false;
                        return el.textContent.trim().includes('照片证据');
                    });
                    if (titleEl) {
                        let current = titleEl.parentElement;
                        let img = null;
                        while (current && current !== q10Card) {
                            img = current.querySelector('img');
                            if (img) break;
                            current = current.parentElement;
                        }
                        if (img) {
                            img.click(); // 自动模拟点击第一张图，弹出联动工作台
                        }
                    }
                }, 500);

            }

            if (attempts > 30) {
                clearInterval(interval);
                GM_setValue('sj_excel_autofocus_q10', false);
            }
        }, 300);
    }

    // 脚本启动逻辑
    const init = () => {
        createConfigPanel();
        markCurrentOrderAsViewed();
        updateNavbarProgress();
        
        // 动态注入与自动折叠检测
        setInterval(() => {
            injectComparisonUI();
            excelHelperCollapseUnneeded();
        }, 1000);

        handleAutofocus();
    };

    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }
})();
