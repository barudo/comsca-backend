class TransactionEntriesHandler {
  async list(request, response, next) {
    try {
      const database = request.app.locals.database;
      const group_id = request.group.id;
      const user = await database("users")
        .where({ auth_user_id: request.authUser.id, group_id }).first("id", "role");
      if (!user || !["OWNER", "ADMIN"].includes(user.role)) {
        return response.status(403).json({ success: false, error: "Only an OWNER or ADMIN of this group can view transaction entries" });
      }

      const transaction_id = request.params.transactionId;
      if (!/^[1-9][0-9]{0,18}$/.test(transaction_id) || BigInt(transaction_id) > 9223372036854775807n) {
        return response.status(400).json({ success: false, error: "transactionId must be a positive bigint ID" });
      }
      const transaction = await database("transactions").where({ group_id, id: transaction_id }).first("id");
      if (!transaction) {
        return response.status(404).json({ success: false, error: "Transaction not found" });
      }
      const data = await database("transaction_entries")
        .where({ group_id, transaction_id }).select("*").orderBy("id", "asc");
      return response.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  }
}

module.exports = TransactionEntriesHandler;
