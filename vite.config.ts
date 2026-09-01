import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  const server = mode === "server";
  return {
    // Runtime basePath is deployment-specific. Relative client URLs keep CSS
    // fonts and lazy chunks under <basePath>/assets/m5/ without rebuilding.
    base: "./",
    plugins: [react()],
    build: server
      ? {
          ssr: resolve("src/web/react/render.tsx"),
          outDir: ".cloud-dist/src/web/react",
          emptyOutDir: true,
          sourcemap: true,
          rollupOptions: {
            output: {
              entryFileNames: "render.js",
            },
          },
        }
      : {
          outDir: ".cloud-dist/client",
          emptyOutDir: true,
          sourcemap: false,
          cssCodeSplit: false,
          rollupOptions: {
            input: resolve("src/web/react/client.tsx"),
            output: {
              entryFileNames: "m5-client.js",
              chunkFileNames: "assets/[name]-[hash].js",
              assetFileNames: (assetInfo) => assetInfo.name?.endsWith(".css")
                ? "m5.css"
                : "assets/[name]-[hash][extname]",
            },
          },
        },
  };
});
