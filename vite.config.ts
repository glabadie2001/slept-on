import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" keeps the built app relocatable (GitHub Pages subpath, local file
// serving, any static host).
export default defineConfig({
  plugins: [react()],
  base: "./",
});
