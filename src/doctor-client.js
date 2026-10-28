async function doctorRequest(path, checkDeepSeek = false) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ browser: { userAgent: navigator.userAgent }, checkDeepSeek }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `诊断请求失败（${response.status}）。`);
  }
  return response;
}

export async function runDoctor(checkDeepSeek = false) {
  const response = await doctorRequest('/api/doctor', checkDeepSeek);
  return response.json();
}

export async function downloadDoctorLogs() {
  const response = await doctorRequest('/api/doctor/log-bundle');
  const disposition = response.headers.get('content-disposition') || '';
  const name = disposition.match(/filename="([^"]+)"/)?.[1] || 'h3-doctor.zip';
  return { blob: await response.blob(), name };
}
