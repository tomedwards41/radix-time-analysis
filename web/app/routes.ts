import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/index.tsx"),
  route("ps",      "routes/ps.tsx"),
  route("radix-rd", "routes/radix-rd.tsx"),
  route("enc-rd",   "routes/enc-rd.tsx"),
  route("upload",   "routes/upload.tsx"),
  route("roster",    "routes/roster.tsx"),
  route("interco-rd", "routes/interco-rd.tsx"),
] satisfies RouteConfig;
