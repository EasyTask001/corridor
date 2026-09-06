import base from "@corridor/config/eslint/base.js";
import nextVitals from "eslint-config-next/core-web-vitals";

export default [...base, ...nextVitals, { ignores: [".next/**", "next-env.d.ts"] }];
