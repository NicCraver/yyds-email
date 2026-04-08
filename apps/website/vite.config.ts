import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  /** 开发时把 /v1 代理到官方 API，浏览器只访问同源，避免 CORS */
  server: {
    proxy: {
      "/v1": {
        target: "https://maliapi.215.im",
        changeOrigin: true,
      },
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
