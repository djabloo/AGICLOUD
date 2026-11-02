import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agyErroreRecuperato } from './agy-errors.js';

test("errore 503 transitorio e' recuperato", () => {
  assert.ok(agyErroreRecuperato('... UNAVAILABLE (code 503) ...'));
});

test("errore Malformed function call (recuperato da agy con retry) e' recuperato", () => {
  assert.ok(
    agyErroreRecuperato(
      'Malformed function call: Failed to parse function call... Please retry with a properly formatted function call. Retries remaining: 2/3',
    ),
  );
  assert.ok(agyErroreRecuperato('something went wrong due to malformed function call in the prompt'));
});

test("errore improperly formatted function call e' recuperato", () => {
  assert.ok(agyErroreRecuperato('improperly formatted function call detected'));
});

test("uno string vuoto o non errore non e' recuperato", () => {
  assert.equal(agyErroreRecuperato(''), false);
  assert.equal(agyErroreRecuperato(undefined), false);
  assert.equal(agyErroreRecuperato(42 as never), false);
});

test('altri errori non triggerano il recupero', () => {
  assert.equal(agyErroreRecuperato('UNAVAILABLE (codice 504) ma typo'), false);
  assert.equal(agyErroreRecuperato('some fatal internal error'), false);
  assert.equal(agyErroreRecuperato('PERMISSION_DENIED'), false);
});
