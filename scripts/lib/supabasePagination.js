async function fetchAllRows(builderFactory, batchSize = 1000) {
  const rows = [];
  let offset = 0;

  while (true) {
    const { data, error } = await builderFactory()
      .range(offset, offset + batchSize - 1);

    if (error) throw error;

    const batch = data || [];
    rows.push(...batch);

    if (batch.length < batchSize) {
      break;
    }

    offset += batchSize;
  }

  return rows;
}

module.exports = {
  fetchAllRows
};
