const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');

function requestRoot() {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      fetch(`http://127.0.0.1:${port}/`)
        .then(async (response) => {
          resolve({ status: response.status, body: await response.json() });
        })
        .catch(reject)
        .finally(() => server.close());
    });
  });
}

test('GET / returns the welcome response', async () => {
  const result = await requestRoot();

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    success: true,
    message: 'On this site will rise the awesome'
  });
});
