import { validateManagementSnapshot } from "./management-model.js";
export class ManagementError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}
export async function managementRequest(
  url,
  {
    origin,
    fetcher = fetch,
    command,
    signal,
    requireSessionExpiry = false,
  } = {},
) {
  const target = new URL(url);
  if (target.origin !== origin)
    throw new ManagementError("configuration", "管理 API 必须与页面同域");
  let response;
  try {
    response = await fetcher(target, {
      method: command ? "POST" : "GET",
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
      signal,
      headers: command
        ? {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-DSH-Management": "1",
          }
        : { Accept: "application/json" },
      ...(command ? { body: JSON.stringify(command) } : {}),
    });
  } catch (error) {
    throw new ManagementError(
      "connection",
      command
        ? "保存结果尚未确认，可重试同一操作以查询幂等回执"
        : "暂时无法连接管理数据源",
    );
  }
  if (
    response.type === "opaqueredirect" ||
    response.redirected ||
    response.status === 401
  )
    throw new ManagementError(
      "authentication",
      "访问已到期，请刷新页面重新验证",
    );
  if (response.status === 403)
    throw new ManagementError(
      "authorization",
      "没有管理权限，或请求未通过同源校验",
    );
  if (
    !(response.headers.get("content-type") || "").includes("application/json")
  )
    throw new ManagementError("connection", "管理服务未配置或返回格式错误");
  const expiresAt = Date.parse(
    response.headers.get("x-dsh-session-expires-at"),
  );
  if (
    requireSessionExpiry &&
    (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
  )
    throw new ManagementError(
      "authentication",
      "访问已到期，请刷新页面重新验证",
    );
  let body;
  try {
    body = await response.json();
  } catch {
    throw new ManagementError("connection", "服务返回不完整，操作结果尚未确认");
  }
  if (requireSessionExpiry && expiresAt <= Date.now())
    throw new ManagementError(
      "authentication",
      "访问已到期，请刷新页面重新验证",
    );
  if (!response.ok) {
    const conflict = response.status === 409;
    throw new ManagementError(
      conflict ? "conflict" : "validation",
      conflict
        ? "记录已变化或当前状态不可编辑。请取消表单、刷新后重试"
        : `操作未保存（${body.code || response.status}）`,
    );
  }
  return command
    ? { receipt: body, expiresAt }
    : { snapshot: validateManagementSnapshot(body), expiresAt };
}
