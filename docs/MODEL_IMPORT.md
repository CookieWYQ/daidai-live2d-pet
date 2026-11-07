# Live2D Model Import

## 支持格式

- Cubism 2：`.model.json`
- Cubism 3/4：`.model3.json`

## 导入流程

1. 打开托盘菜单里的“打开管理”
2. 点击“导入 Live2D 目录”
3. 选择包含 model json 的目录
4. 在模型列表中点击“使用”

导入后，项目会把整个模型目录复制到 Electron userData 下，避免原始目录移动导致模型丢失。

## 开源注意

不要把版权不清的模型提交到仓库。推荐做法：

- README 只说明导入方法
- 示例模型使用明确允许再分发的 license
- 自定义呆呆模型完成后，在模型目录旁放 `LICENSE` 或 `NOTICE`
