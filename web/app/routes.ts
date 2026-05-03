import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/ps.tsx"),
  route("ps",      "routes/ps.tsx"),
  route("radix-rd", "routes/radix-rd.tsx"),
  route("enc-rd",   "routes/enc-rd.tsx"),
  route("upload",   "routes/upload.tsx"),
  route("roster",   "routes/roster.tsx"),
] satisfies RouteConfig;
