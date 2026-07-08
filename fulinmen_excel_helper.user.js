// ==UserScript==
// @name         爱零工审单数据助手-福临门排面对账版
// @namespace    http://tampermonkey.net/
// @version      1.2.5
// @description  上传 Excel 文件进行排队对账，直接修改并保存原版 Workbook 单元格值，支持导出 100% 原格式的 Excel。
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

    // 独立记录 Excel 助手折叠过的卡片状态
    const manuallyExpandedQuestionsExcel = new Set();

    // 默认键名变量，自动识别 Excel 列名
    let orderIdKey = "工单ID";
    let handlerKey = "处理人";
    let totalFacingKey = "【主货架排面】所有品牌食用油主货架排面数";
    let flmFacingKey = "【主货架排面】福临门品牌食用油主货架排面数";

    // 寻找表头在 Sheet1 里的列索引
    function findColumnIndices(sheet) {
        const range = XLSX.utils.decode_range(sheet['!ref']);
        let indices = { orderIdCol: -1, totalCol: -1, flmCol: -1, handlerCol: -1 };

        // 假设表头在第一行 (r = range.s.r)
        const R = range.s.r;
        for (let C = range.s.c; C <= range.e.c; ++C) {
            const cellRef = XLSX.utils.encode_cell({ r: R, c: C });
            const cell = sheet[cellRef];
            if (cell && cell.v) {
                const val = String(cell.v).toLowerCase();
                if (val.includes("工单id") || val.includes("工单号")) {
                    indices.orderIdCol = C;
                } else if (val.includes("处理人") || val.includes("审核员")) {
                    indices.handlerCol = C;
                } else if (val.includes("所有品牌") && val.includes("主货架排面")) {
                    indices.totalCol = C;
                } else if (val.includes("福临门") && val.includes("主货架排面")) {
                    indices.flmCol = C;
                }
            }
        }
        return indices;
    }

    // 从本地缓存读取和保存 Excel 的整个二进制 Workbook 对象
    function getWorkbook() {
        const base64 = GM_getValue('sj_excel_workbook', '');
        if (!base64) return null;
        try {
            return XLSX.read(base64, { type: 'base64' });
        } catch (e) {
            console.error("Failed to read workbook:", e);
            return null;
        }
    }

    function saveWorkbook(workbook) {
        try {
            const base64 = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });
            GM_setValue('sj_excel_workbook', base64);
        } catch (e) {
            console.error("Failed to save workbook:", e);
        }
    }

    // 从本地缓存读取和保存队列元数据
    function getStoredQueue() {
        const json = GM_getValue('sj_excel_queue', '[]');
        try {
            return JSON.parse(json);
        } catch (e) {
            return [];
        }
    }

    function saveQueue(queue) {
        GM_setValue('sj_excel_queue', JSON.stringify(queue));
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
        /* 对账版专属折叠卡片样式（独立类名，防止覆盖原插件） */
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
        /* 屏蔽原版插件的展开/收起按钮，防止双重按钮出现 */
        .sj-collapse-toggle-btn {
            display: none !important;
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

    // 筛选当前处理人的所有工单列表
    function getActiveQueue() {
        const handler = GM_getValue('sj_excel_handler', '');
        const queue = getStoredQueue();
        if (!handler || queue.length === 0) return [];
        return queue.filter(item => item.handler === handler);
    }

    // 标记当前工单为“已看过”
    function markCurrentOrderAsViewed() {
        const currentId = getOrderFromUrl();
        if (!currentId) return;
        const queue = getStoredQueue();
        let updated = false;
        for (let item of queue) {
            if (item.id === currentId) {
                if (item.viewed !== "是" && item.viewed !== "集") {
                    item.viewed = "是";
                    updated = true;
                }
                break;
            }
        }
        if (updated) {
            saveQueue(queue);
            updateNavbarProgress();
        }
    }

    // 更新轻量队列数值 (仅修改 localStorage 中极小的 JSON，完全不卡顿，0ms 延时)
    function updateQueueValue(orderId, totalVal, flmVal) {
        const queue = getStoredQueue();
        const matched = queue.find(item => item.id === orderId);
        if (!matched) return;

        matched.total = totalVal;
        matched.flm = flmVal;
        matched.viewed = "集"; // 标记为待同步改写
        saveQueue(queue);
    }

    // 将轻量队列中所有标记为“集”的改动，批量一次性写回并保存原装二进制 Workbook
    // (仅在导出时执行，平时审核时绝对不调用，从而保障 100% 毫无卡顿！)
    function syncQueueToWorkbook() {
        const queue = getStoredQueue();
        const workbook = getWorkbook();
        if (!workbook || queue.length === 0) return;

        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const indices = findColumnIndices(sheet);

        let modified = false;
        queue.forEach(item => {
            if (item.viewed === "集") {
                if (indices.totalCol !== -1 && item.total !== "") {
                    const cellRef = XLSX.utils.encode_cell({ r: item.rowIdx, c: indices.totalCol });
                    sheet[cellRef] = { t: 'n', v: Number(item.total) };
                    modified = true;
                }
                if (indices.flmCol !== -1 && item.flm !== "") {
                    const cellRef = XLSX.utils.encode_cell({ r: item.rowIdx, c: indices.flmCol });
                    sheet[cellRef] = { t: 'n', v: Number(item.flm) };
                    modified = true;
                }
                item.viewed = "是"; // 状态收敛为已保存
            }
        });

        if (modified) {
            saveWorkbook(workbook);
            saveQueue(queue);
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

        const queue = getStoredQueue();
        const handlerSet = new Set();
        queue.forEach(item => {
            if (item.handler) handlerSet.add(item.handler);
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

    // 上传文件解析并保存 Workbook
    function handleFileUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        GM_setValue('sj_excel_filename', file.name);

        const reader = new FileReader();
        reader.onload = function(evt) {
            try {
                const data = new Uint8Array(evt.target.result);
                // 读入原版二进制 workbook
                const workbook = XLSX.read(data, {
                    type: 'array',
                    cellStyles: true,
                    cellFormulas: true,
                    cellDates: true,
                    cellNF: true
                });

                // 保存整个 Workbook
                saveWorkbook(workbook);

                const sheetName = workbook.SheetNames[0];
                const sheet = workbook.Sheets[sheetName];

                // 识别列名并生成纯净进度队列，只保存元数据，不破坏 Workbook 整体
                const indices = findColumnIndices(sheet);
                if (indices.orderIdCol === -1 || indices.handlerCol === -1) {
                    alert("❌ 无法识别“工单ID”或“处理人”列，请检查表格表头！");
                    return;
                }

                const range = XLSX.utils.decode_range(sheet['!ref']);
                const queue = [];

                for (let R = range.s.r + 1; R <= range.e.r; ++R) {
                    const idCell = sheet[XLSX.utils.encode_cell({ r: R, c: indices.orderIdCol })];
                    const handlerCell = sheet[XLSX.utils.encode_cell({ r: R, c: indices.handlerCol })];
                    const totalCell = sheet[XLSX.utils.encode_cell({ r: R, c: indices.totalCol })];
                    const flmCell = sheet[XLSX.utils.encode_cell({ r: R, c: indices.flmCol })];

                    if (idCell && idCell.v) {
                        const totalVal = (totalCell && totalCell.v !== undefined) ? String(totalCell.v).trim() : "";
                        const flmVal = (flmCell && flmCell.v !== undefined) ? String(flmCell.v).trim() : "";

                        queue.push({
                            id: String(idCell.v).trim(),
                            rowIdx: R,
                            handler: handlerCell ? String(handlerCell.v).trim() : "",
                            total: totalVal,
                            flm: flmVal,
                            viewed: (totalVal !== "" && parseInt(totalVal, 10) > 0) ? "是" : "否"
                        });
                    }
                }

                if (queue.length > 0) {
                    saveQueue(queue);
                    updateAuditorDropdown();
                    updateNavbarProgress();
                    alert(`🎉 成功导入原版 Excel 文件！共识别 ${queue.length} 个工单。`);
                    location.reload();
                } else {
                    alert("⚠️ 未在表格的第一张 Sheet 中找到有效数据！");
                }
            } catch (err) {
                console.error(err);
                alert("❌ Excel 解析失败: " + err.message);
            }
        };
        reader.readAsArrayBuffer(file);
    }

    // 直接下载完全原装保存的原版 Excel
    function handleExportExcel() {
        // 导出前强制同步所有改动到二进制文件
        syncQueueToWorkbook();
        const workbook = getWorkbook();
        if (!workbook) {
            alert("⚠️ 没有导入任何数据！");
            return;
        }
        try {
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
        const viewed = queue.filter(r => r.viewed === "集" || r.viewed === "是").length;

        // 寻找当前工单在队列中的索引
        let currentIndex = -1;
        for (let i = 0; i < queue.length; i++) {
            if (queue[i].id === currentId) {
                currentIndex = i;
                break;
            }
        }

        // 上一单和下一单直接在物理行队列中进行加减（不跳过已看过，保证顺序 100% 正确）
        let prevId = (currentIndex > 0) ? queue[currentIndex - 1].id : null;
        let nextId = (currentIndex >= 0 && currentIndex < queue.length - 1) ? queue[currentIndex + 1].id : null;

        // 读取当前订单的值，用于顶部导航比对
        const targetRow = queue.find(row => row.id === currentId);
        const totalVal = targetRow ? targetRow.total : "";
        const flmVal = targetRow ? targetRow.flm : "";

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
                updateQueueValue(currentId, e.target.value, flmInput.value);
                const q10Input = document.getElementById('sj-q10-total-input');
                if (q10Input) q10Input.value = e.target.value;
            });

            const flmInput = navCmp.querySelector('#sj-nav-flm-facing');
            flmInput.addEventListener('input', (e) => {
                updateQueueValue(currentId, totalInput.value, e.target.value);
                const q10Input = document.getElementById('sj-q10-flm-input');
                if (q10Input) q10Input.value = e.target.value;
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

        const queue = getStoredQueue();
        const targetRow = queue.find(row => row.id === currentId);
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

        const totalVal = targetRow.total;
        const flmVal = targetRow.flm;

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
            updateQueueValue(currentId, e.target.value, flmInput.value);
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
            updateQueueValue(currentId, totalInput.value, e.target.value);
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
        let temp = reviewEl.parentElement;
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
