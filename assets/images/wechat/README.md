# 微信内置相册素材

这三张照片用于不露脸的虚构场景配图或参考图。来自 Unsplash，按 [Unsplash License](https://unsplash.com/license) 使用；图片本身不是角色本人、拍摄日期或所在地的证据。

| 文件 | 原图下载地址 | 已核对的画面 |
| --- | --- | --- |
| salad.jpg | https://images.unsplash.com/photo-1512621776951-a57141f2eefd | 木桌上的蔬菜沙拉 |
| desk.jpg | https://images.unsplash.com/photo-1497215728101-856f4ea42174 | 窗边办公桌、电脑和绿植 |
| cat.jpg | https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba | 绿背景前的黑白猫 |

下载时缩至约 960 像素宽，已逐张查看并填写短描述。素材本地随应用提供，无需生图 Key，运行时不必请求 Unsplash。

同名 `.js` 文件保存对应照片的固定像素字节，仅在 `file://` 打开应用时按需加载，绕过本地图片的 Canvas 跨源限制。它们是分发资源，不是模型生成的程序，也不会送入聊天上下文。更换照片时须同时更新 `.jpg`、`.js` 与 `wechat-media.js` 中的画面描述。
