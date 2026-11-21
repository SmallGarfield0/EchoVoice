# FASTBUILD

## 安装依赖

```powershell
npm --prefix apps/desktop ci
```

## 编译 Web 客户端

```powershell
npm run desktop:build
```

## 打包桌面客户端

```powershell
npm run tauri:build
```

## 打包 EV Server

```powershell
npm run server:build
```

## 构建 EV Server Docker 镜像

```powershell
docker compose -f infra/compose/docker-compose.yml build ev-server
```

## 构建缓存清理

Cargo 不会回收旧产物：`Cargo.lock` 里的依赖升级后，上一版的
`rlib`/`rmeta`/`pdb` 仍留在 `target/<profile>/deps`；每次调试还会留下一个
`incremental` 会话目录。本项目因此累积到过 22 GB。

`npm run tauri:dev` 与 `npm run tauri:build` 会在编译前自动执行
`scripts/prune-build-caches.mjs`（12 小时内最多一次，失败不影响构建）。也可手动：

```powershell
npm run cache:prune                       # 立即清理
node scripts/prune-build-caches.mjs --dry-run --verbose   # 只看会删什么
```

清理是保守的：只有当某个产物的版本已不在 `Cargo.lock` 中（或 `crate` 名已
离开依赖图）才会删除，无法识别的产物（本地 crate、git 依赖、缺少 `.d`）一律保留，
所以不会触发活依赖重新编译。`incremental` 只保留每个 profile 最新的 2 个会话。

如需给 `target/` 设硬上限（会驱逐旧产物、可能导致重编，默认关闭）：

```powershell
node scripts/prune-build-caches.mjs --max-size=12GB
```

打包产物（`target/release/bundle` 下的 `.msi` / `.exe`）不属于缓存，清理不会动它，
建议发布后复制到 `target/` 之外的目录。
