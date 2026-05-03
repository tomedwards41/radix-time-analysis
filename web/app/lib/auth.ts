import type { UserAccess } from "./types";

type D1Database = {
  prepare: (query: string) => {
    bind: (...values: unknown[]) => {
      first: <T = unknown>() => Promise<T | null>;
    };
  };
};

export async function requireAccess(
  authDb: D1Database,
  request: Request,
  dashboard: string = "labor",
  requiredLevel: "view" | "edit" | "admin" = "view"
): Promise<UserAccess> {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) {
    return { email: "dev@radixiot.com", accessLevel: "admin" };
  }

  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new Response("Invalid JWT", { status: 401 });
  }

  const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  const email = payload.email as string;

  if (!email) {
    throw new Response("No email in JWT", { status: 401 });
  }

  const access = await authDb
    .prepare("SELECT access_level FROM dashboard_access WHERE user_id = ? AND dashboard = ?")
    .bind(email, dashboard)
    .first<{ access_level: string }>();

  const accessLevel = (access?.access_level ?? "none") as UserAccess["accessLevel"];

  const levels = ["none", "view", "edit", "admin"];
  if (levels.indexOf(accessLevel) < levels.indexOf(requiredLevel)) {
    throw new Response("Forbidden", { status: 403 });
  }

  return { email, accessLevel };
}
