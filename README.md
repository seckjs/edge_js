# Chaoxing Edge Assistant Extension

### 项目根据我们的计算机设计大赛的作品改编的
主要功能是用于超星学习通教师端主观题辅助批改的，减轻教师对于大量主观题的批改

## 本地加载

1. 打开 `edge://extensions/`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择当前目录 `edge_js/`

加载完成后，建议把扩展固定到工具栏，方便打开主页、日志和设置面板。

## 主要文件

- `manifest.json`：扩展入口、权限、匹配站点和资源声明
- `background.js`：后台逻辑、消息转发、下载与权限相关处理
- `content.js`：注入超星页面，负责页面识别、抓取、批阅流程和交互
- `popup.html` / `popup.js` / `popup.css`：扩展弹窗界面
- `review-shared.js`：批阅流程共用逻辑
- `page-bridge.js`：页面桥接脚本
- `icons/`：扩展图标资源

## 说明

- 当前扩展基于 Manifest V3
- 支持通过弹窗配置 OpenAI 兼容接口
- 如需重新加载最新代码，可回到扩展管理页点击“重新加载”
