# 🤖 爱零工审单数据助手（福临门专版）

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-Supported-green.svg)](https://www.tampermonkey.net/)
[![Platform](https://img.shields.io/badge/Platform-Slicejobs-orange.svg)](http://admin2.slicejobs.com/)

这是一款专门为 **“爱零工（Slicejobs）”** 平台审核员设计的浏览器辅助脚本（油猴插件）。旨在通过自动化交互、智能识别与数据分析，极速提升**福临门**相关审核任务的工作效率，减少繁琐的重复点击。

---

## ⚙️ 极速安装与更新

1.  请确保您的浏览器已安装 **[Tampermonkey (油猴)](https://www.tampermonkey.net/)** 扩展。
2.  点击下方链接直接安装或自动更新至最新版本：
    *   👉 **[点此直链安装/更新《爱零工审单数据助手福临门》](https://raw.githubusercontent.com/3169657175/fulinmen/master/fulinmen_stats_helper.user.js)**
    *(点击后油猴会自动拦截并弹出安装确认页面，点击“安装”或“更新”即可)*
3.  匹配域名：`*://admin2.slicejobs.com/*`

---

## 🌟 核心功能特性

### 📊 1. 审核效率实时统计 HUD
*   **双模式悬浮球**：页面右下角常驻状态球，双击可切换“迷你圆球”与“展开详情条”模式，支持拖拽并记忆位置。
*   **多维度指标看板**：实时计算今日初审量、总审核量、与每日目标的差值。
*   **间隔积分时速算法**：采用先进的时间间隔累加算法，自动剔除空闲/休息时间，还原您真实的**无稀释瞬时手速**。
*   **历史数据大屏**：按下快捷键 `Alt + S` 唤起全屏玻璃拟态暗黑面板，查询每小时产量对比（带昨日对比柱状图）及近 7 日效率趋势，并支持一键导出 CSV 报表。

### ⚡ 2. 一键快速通过 (Alt + A)
*   **全自动过单**：按下 `Alt + A` 或点击控制面板按钮，脚本将自动选择全部单选题的最高星级/合规选项并直接提交，秒速进入下一单。
*   **智能安全防御**：若您已经对某道题手动选择了“不通过”或进行了标注，一键通过功能会自动跳过该题，绝不覆盖您的手动审核决策。

### 📂 3. 题目智能折叠
*   **专版折叠清单**：为了界面紧凑，系统会在进入审核页时自动折叠 **1、2、3、19、20、21** 题（并提供点击展开/收起的快速按钮）。

---

## 📄 许可证

本项目基于 [MIT](LICENSE) 许可证开源。
