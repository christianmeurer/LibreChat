export function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

export function okResult(value) {
  return {
    content: [
      {
        type: 'text',
        text: jsonText({ ok: true, ...value }),
      },
    ],
  };
}

export function errorResult(code, message, details) {
  const error = details === undefined ? { code, message } : { code, message, details };
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: jsonText({ ok: false, error }),
      },
    ],
  };
}

