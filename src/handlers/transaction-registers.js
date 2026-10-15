const documents = {
  PR: ["RECEIPT", "PAYMENT_RECEIPT"],
  DV: ["DISBURSEMENT_VOUCHER"],
  JV: ["JOURNAL_VOUCHER"],
};
const sortColumns = ["id", "occurred_at", "created_at", "updated_at", "document_number", "document_type", "amount", "type", "status", "cycle_id"];

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function text(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string") invalid(`${name} must be a single string`);
  return value;
}

function positiveInteger(value, name, fallback, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) invalid(`${name} must be a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) invalid(`${name} is out of range`);
  return number;
}

function parse(query) {
  const document = text(query.document, "document", "");
  if (document !== "" && !Object.hasOwn(documents, document)) invalid("document must be PR, DV or JV");
  const per_page = positiveInteger(query.per_page, "per_page", 25, 100);
  const page = positiveInteger(query.page, "page", 1, Number.MAX_SAFE_INTEGER);
  const offset = (page - 1) * per_page;
  if (!Number.isSafeInteger(offset)) invalid("page is out of range");
  const sorty_by = text(query.sorty_by, "sorty_by", undefined);
  const sort_by = text(query.sort_by, "sort_by", undefined);
  if (sorty_by !== undefined && sort_by !== undefined && sorty_by !== sort_by) invalid("sorty_by and sort_by must match when both are provided");
  const sort = sorty_by ?? sort_by ?? "occurred_at";
  if (!sortColumns.includes(sort)) invalid(`Sort column must be one of: ${sortColumns.join(", ")}`);
  const order = text(query.order, "order", "desc");
  if (!["asc", "desc"].includes(order)) invalid("order must be asc or desc");
  return { document, per_page, page, offset, sort, order };
}

class TransactionRegistersHandler {
  async list(request, response, next) {
    try {
      const result = await request.app.locals.database.transaction(async trx => {
        await trx.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
        const group_id = request.group.id;
        const user = await trx("users").where({ auth_user_id: request.authUser.id, group_id }).first("id", "role");
        if (!user || !["OWNER", "ADMIN"].includes(user.role)) {
          throw Object.assign(new Error("Only an OWNER or ADMIN of this group can view transaction registers"), { status: 403 });
        }
        const input = parse(request.query);
        const types = input.document ? documents[input.document] : Object.values(documents).flat();
        const base = trx("transactions").where({ group_id })
          .whereIn("document_type", types).whereNotNull("document_number");
        const count = await base.clone().count("* as total").first();
        const total = Number(count.total);
        if (!Number.isSafeInteger(total)) throw new Error("Register count exceeds supported pagination range");
        const rows = base.clone().select("*").orderBy(input.sort, input.order, "last");
        if (input.sort !== "id") rows.orderBy("id", input.order);
        const data = await rows.limit(input.per_page).offset(input.offset);
        return { success: true, data, pagination: {
          page: input.page, per_page: input.per_page, total, total_pages: Math.ceil(total / input.per_page),
        } };
      });
      return response.json(result);
    } catch (error) {
      if ([400, 403].includes(error.status)) return response.status(error.status).json({ success: false, error: error.message });
      return next(error);
    }
  }
}
module.exports = TransactionRegistersHandler;
