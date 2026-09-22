import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cloud Run executes the self-contained Next.js server emitted here.
  output: "standalone",
  // Production builds should type-check the application without compiling test fixtures.
  typescript: {
    tsconfigPath: "./tsconfig.build.json",
  },
};

export default nextConfig;
