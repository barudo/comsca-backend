const userFields = ["id", "group_id", "first_name", "family_name", "username",
  "email", "phone", "address", "role", "created_at", "updated_at"];

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
      const rows = await database("transaction_entries as entries")
        .leftJoin("users as entry_user", function () {
          this.on("entry_user.id", "=", "entries.user_id")
            .andOn("entry_user.group_id", "=", "entries.group_id");
        })
        .where({ "entries.group_id": group_id, "entries.transaction_id": transaction_id })
        .select("entries.*", ...userFields.map(field => `entry_user.${field} as entry_user_${field}`))
        .orderBy("entries.id", "asc");
      const data = rows.map(row => {
        const entry = { ...row };
        const user = row.entry_user_id == null ? null : {};
        for (const field of userFields) {
          if (user) user[field] = row[`entry_user_${field}`];
          delete entry[`entry_user_${field}`];
        }
        return { ...entry, user };
      });
      return response.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  }
}

module.exports = TransactionEntriesHandler;
