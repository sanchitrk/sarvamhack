import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    cache: true,
  },
  pack: {
    dts: true,
    exports: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
