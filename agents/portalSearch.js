
const axios = require("axios");

async function searchPortal(brand) {

  const query =
    `${brand} facturación México`;

  const url =
`https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${process.env.SERP_API_KEY}`;

  const res =
    await axios.get(url);

  const results =
    res.data.organic_results;

  if (!results.length)
    throw new Error(
      "No search results"
    );

  console.log(
    "🔎 Portal encontrado:",
    results[0].link
  );

  return results[0].link;

}

module.exports = {
  searchPortal
};
