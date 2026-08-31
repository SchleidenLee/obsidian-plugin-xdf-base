import { defineConfig } from "vitest/config";

// 临时配置：/mnt/x（9P 跨盘）IO 慢，加大 worker 超时
// 注：Vitest 4 移除了 poolOptions/singleThread，默认调度即可
export default defineConfig({
    test: {
        pool: "threads",
        hookTimeout: 120000,
        teardownTimeout: 120000,
    },
});
