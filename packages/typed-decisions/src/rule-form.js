/* Form state keeps text/number/boolean distinct; wire JSON is produced only on save. */
let valueNodeSerial = 0;
const unsafeFields = new Set(["__proto__", "prototype", "constructor"]);
export function valueDraft(value, depth = 0) {
  if (depth > 64) throw Error("匹配值嵌套层级过深。");
  const kind =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const node = { uid: ++valueNodeSerial, kind };
  if (kind === "array") node.items = value.map((v) => valueDraft(v, depth + 1));
  else if (kind === "object")
    node.items = Object.entries(value).map(([key, v]) => ({
      key,
      node: valueDraft(v, depth + 1),
    }));
  else if (kind === "number") node.value = String(value);
  else if (kind === "string" || kind === "boolean") node.value = value;
  else if (kind !== "null") throw Error("不支持这个匹配值类型。");
  return node;
}
export function readValueDraft(node, depth = 0) {
  if (depth > 64) throw Error("匹配值嵌套层级过深。");
  if (node.kind === "null") return null;
  if (node.kind === "string") return String(node.value);
  if (node.kind === "boolean") {
    if (typeof node.value !== "boolean") throw Error("请选择是或否。");
    return node.value;
  }
  if (node.kind === "number") {
    if (
      typeof node.value !== "string" ||
      !node.value.trim() ||
      !Number.isFinite(Number(node.value))
    )
      throw Error("请输入有效的有限数字。");
    return Number(node.value);
  }
  if (node.kind === "array")
    return node.items.map((n) => readValueDraft(n, depth + 1));
  if (node.kind === "object") {
    const result = {};
    const keys = new Set();
    for (const { key, node: child } of node.items) {
      if (unsafeFields.has(key)) throw Error("这个字段名不能用于匹配值。");
      if (keys.has(key)) throw Error("对象中不能有重复字段名。");
      keys.add(key);
      result[key] = readValueDraft(child, depth + 1);
    }
    return result;
  }
  throw Error("请选择匹配值的类型。");
}
export function ruleForm(rule) {
  const answer = rule.answer;
  return {
    questionId: rule.questionId,
    questionVersion: rule.questionVersion,
    path: [...rule.path],
    equals: valueDraft(rule.equals),
    answerType: answer.type,
    answerValue: String(
      answer.choice ?? answer.noul ?? answer.score ?? answer.reason ?? "",
    ),
  };
}
function safeField(value, label) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    unsafeFields.has(value)
  )
    throw Error(label + "必须是有效的字段名，最多 256 个字符。");
  return value;
}
export function readRuleForm(form) {
  const questionId = safeField(form.questionId.trim(), "问题 ID");
  const questionVersion = form.questionVersion.trim();
  if (!questionVersion || questionVersion.length > 65536)
    throw Error("请输入问题版本。");
  const path = form.path.map((segment) => safeField(segment, "路径段"));
  let answer;
  if (form.answerType === "choice")
    answer = {
      type: "choice",
      choice: safeField(form.answerValue.trim(), "候选项 ID"),
    };
  else if (form.answerType === "abstain") {
    if (!form.answerValue.trim() || form.answerValue.length > 65536)
      throw Error("请填写放弃选择的原因。");
    answer = { type: "abstain", reason: form.answerValue.trim() };
  } else if (form.answerType === "noul" || form.answerType === "score") {
    const value = Number(form.answerValue),
      max = form.answerType === "noul" ? 1 : 9;
    if (
      !form.answerValue.trim() ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > max
    )
      throw Error("答案必须是 0～" + max + " 之间的数字。");
    answer = { type: form.answerType, [form.answerType]: value };
  } else throw Error("请选择答案类型。");
  return {
    questionId,
    questionVersion,
    path,
    equals: readValueDraft(form.equals),
    answer,
  };
}
export function valueSummary(value) {
  if (value === null) return "空值";
  if (Array.isArray(value)) return "列表 · " + value.length + " 项";
  if (typeof value === "object")
    return "对象 · " + Object.keys(value).length + " 个字段";
  if (typeof value === "boolean") return value ? "布尔值：是" : "布尔值：否";
  return (typeof value === "number" ? "数字：" : "文本：") + value;
}
export function answerSummary(answer) {
  if (answer.type === "choice") return "选择候选项：" + answer.choice;
  if (answer.type === "noul") return "0～1 数值：" + answer.noul;
  if (answer.type === "score") return "评分：" + answer.score;
  return "放弃选择：" + answer.reason;
}
