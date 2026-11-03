import type { AuthConfig } from "convex/server";

// This deployment accepts only JWTs issued by this project's own Convex Auth
// instance. No federated issuer from the template/source project is trusted.
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL!,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;
