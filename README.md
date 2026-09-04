# cli-contextbase

ContextBase 在本地提供可验证的 TS/JS 符号级代码、引用、依赖段落、共享缓存和项目地图。

```bash
cli-contextbase install .
cli-contextbase capabilities .
cli-contextbase broker .
```

单次操作从 stdin 读取 JSON：

```bash
cli-contextbase file-read .
cli-contextbase symbol-read .
cli-contextbase refs-read .
cli-contextbase map-build .
cli-contextbase cache-stats .
cli-contextbase budget-report .
```

生产集成应让同一项目的客户端连接一个长生命周期 `broker`，才能共享内存缓存并让第二次相同符号读取不再读取磁盘内容。每次首次读取和文件元数据变化后都会重新读取并校验 SHA-256；ArchGuard checkpoint 通过失效事件通知缓存。没有 TS/JS 适配器时，`symbol-read` 在读取前明确报错；调用方必须显式使用 `file-read` 请求整文件，提供 Aimlock chainId 时计入预算。缓存命中仍校验该链的依赖等待和读取期限；不同链第一次读取相同文件各自记账。`tokenEstimateAvoided` 仅是避免重复磁盘读取的 UTF-8 字节估算，不代表模型实际节省的 token。

代码地图仅在项目至少含 30 个 TS/JS 源文件时构建。更小项目返回 `project-below-map-threshold`，不会读取文件内容建图。
