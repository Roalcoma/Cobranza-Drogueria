let config = { tasa: 0, metodos: [] };
let todosLosClientes = [];
let clienteSeleccionado = null;
let cobrosPendientes = null;

const fMonto = (n) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function mostrarToast(titulo, mensaje, tipo = 'success') {
    const toast = document.getElementById('toastNotif');
    const icon = document.getElementById('toastIcon');
    toast.className = 'toast toast-custom toast-' + tipo;
    icon.className = 'bi me-2 bi-' + (tipo === 'error' ? 'x-circle-fill' : tipo === 'warning' ? 'exclamation-triangle-fill' : 'check-circle-fill');
    icon.style.color = tipo === 'error' ? 'var(--red)' : tipo === 'warning' ? 'var(--yellow)' : 'var(--green)';
    document.getElementById('toastTitle').textContent = titulo;
    document.getElementById('toastBody').textContent = mensaje;
    new bootstrap.Toast(toast, { delay: 4000 }).show();
}

function mostrarLoading(texto) {
    document.getElementById('loadingText').textContent = texto || 'Procesando...';
    document.getElementById('loadingOverlay').classList.add('active');
}
function ocultarLoading() { document.getElementById('loadingOverlay').classList.remove('active'); }

// --- INIT ---
window.onload = async () => {
    document.getElementById('fechaSistema').value = new Date().toISOString().split('T')[0];
    await cargarConfiguracion(document.getElementById('fechaSistema').value);
    document.getElementById('btnConfirmarFinal').addEventListener('click', ejecutarCobro);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') document.querySelectorAll('.modal.show').forEach(m => bootstrap.Modal.getInstance(m)?.hide());
    });
};

async function cargarConfiguracion(fecha) {
    try {
        const res = await fetch(`/api/config?fecha=${fecha}`);
        if (!res.ok) throw new Error();
        config = await res.json();
        document.getElementById('tasaDia').value = config.tasa.toFixed(2);
        if (clienteSeleccionado) actualizarTodoPorTasa();
    } catch (_) { mostrarToast('Error', 'No se pudo cargar la configuracion', 'error'); }
}

function actualizarTasaPorFecha() { cargarConfiguracion(document.getElementById('fechaSistema').value); }

// --- CLIENTES ---
async function obtenerClientes() {
    try {
        const res = await fetch('/api/clientes');
        if (!res.ok) throw new Error();
        todosLosClientes = await res.json();
        dibujarClientes(todosLosClientes);
    } catch (_) { mostrarToast('Error', 'No se pudieron cargar los clientes', 'error'); }
}

function dibujarClientes(lista) {
    const tbody = document.getElementById('tablaClientesModal');
    const vistos = new Set();
    const unicos = lista.filter(c => { if (vistos.has(c.CODCLIENTE)) return false; vistos.add(c.CODCLIENTE); return true; });
    if (!unicos.length) { tbody.innerHTML = '<tr><td colspan="2" class="text-center py-3" style="color:var(--text-muted)">Sin resultados</td></tr>'; return; }
    tbody.innerHTML = unicos.map(c => {
        const cod = String(c.CODCLIENTE);
        const nom = String(c.NOMBRECLIENTE).replace(/'/g, "\\'");
        return `<tr class="cliente-row" onclick="seleccionarCliente('${cod}', '${nom}')">
            <td><span class="chip chip-green">${cod}</span></td>
            <td class="text-start">${c.NOMBRECLIENTE}</td>
        </tr>`;
    }).join('');
}

function filtrarClientes() {
    const t = document.getElementById('filtro').value.toLowerCase();
    dibujarClientes(todosLosClientes.filter(c =>
        c.NOMBRECLIENTE.toLowerCase().includes(t) || String(c.CODCLIENTE).toLowerCase().includes(t)
    ));
}

function seleccionarCliente(codigo, nombre) {
    clienteSeleccionado = { codigo, nombre };
    const cl = todosLosClientes.find(c => String(c.CODCLIENTE) === codigo);
    let info = `<i class="bi bi-person-fill me-1" style="color:var(--green)"></i> <strong>${nombre}</strong> <span class="chip chip-green ms-2">${codigo}</span>`;
    if (cl) {
        const tags = [];
        if (cl.DIASPROTECCION) tags.push(`<span class="badge-prot ms-2"><i class="bi bi-shield me-1"></i>${cl.DIASPROTECCION}d prot.</span>`);
        if (cl.ESCALADIASPP1 && cl.ESCALAPORPP1) {
            let pp = `${cl.ESCALAPORPP1}% (0-${cl.ESCALADIASPP1}d)`;
            if (cl.ESCALADIASPP2 && cl.ESCALAPORPP2) pp += ` | ${cl.ESCALAPORPP2}% (${cl.ESCALADIASPP1+1}-${cl.ESCALADIASPP2}d)`;
            tags.push(`<span class="badge-pp ms-1"><i class="bi bi-tag me-1"></i>PP: ${pp}</span>`);
        }
        info += tags.join('');
    }
    document.getElementById('infoCliente').innerHTML = info;
    bootstrap.Modal.getInstance(document.getElementById('modalClientes')).hide();
    cargarFacturas(codigo);
}

// --- FACTURAS ---
async function cargarFacturas(codigo) {
    const tbody = document.getElementById('tablaFacturas');
    tbody.innerHTML = '<tr><td colspan="10" class="text-center py-4"><div class="loader-ring mx-auto" style="width:28px;height:28px;border-width:2px;"></div></td></tr>';

    try {
        const res = await fetch(`/api/facturas/${codigo}`);
        if (!res.ok) throw new Error();
        const facturas = await res.json();
        const tasaActual = parseFloat(document.getElementById('tasaDia').value);
        tbody.innerHTML = '';

        if (!facturas.length) {
            tbody.innerHTML = '<tr><td colspan="10" class="text-center py-4" style="color:var(--text-muted)">Sin facturas pendientes</td></tr>';
            return;
        }

        facturas.forEach((f, i) => {
            const origBs = f.RestanteUSD * f.TasaOrigen;
            const tasaEfectiva = f.Protegido ? f.TasaOrigen : tasaActual;
            const hoyBs = f.RestanteUSD * tasaEfectiva;
            const dif = hoyBs - origBs;
            const row = document.createElement('tr');
            row.className = 'fade-in';
            row.style.animationDelay = `${i * 30}ms`;
            row.setAttribute('data-usd', f.RestanteUSD);
            row.setAttribute('data-tasa-orig', f.TasaOrigen);
            row.setAttribute('data-fp', f.FormaPagoOriginal);
            row.setAttribute('data-pp', f.DescuentoPP);
            row.setAttribute('data-prot-dias', f.DiasProteccion || 0);
            row.setAttribute('data-prot-activo', f.Protegido ? '1' : '0');
            row.setAttribute('data-dias-entrega', f.DiasDesdeEntrega !== null ? f.DiasDesdeEntrega : '-1');

            // Columna Entrega
            let entregaHtml = '';
            if (f.FechaEntrega) {
                entregaHtml = `<span style="font-size:0.72rem;">${f.FechaEntrega}</span>`;
                if (f.DiasDesdeEntrega !== null) entregaHtml += `<span class="sub-monto">${f.DiasDesdeEntrega} dia(s)</span>`;
            } else {
                entregaHtml = `<span style="color:var(--yellow); font-size:0.72rem;"><i class="bi bi-exclamation-triangle me-1"></i>Sin fecha</span>`;
            }

            // Columna PP / Protección
            let ppHtml = '';
            let protHtmlStored = '';
            const tienePP = f.EscalaDiasPP1 && f.EscalaPorPP1;
            const tieneProteccion = f.DiasProteccion > 0;

            if (f.TieneNI) {
                protHtmlStored = `<span class="badge-pp-expired"><i class="bi bi-shield-x me-1"></i>No indexado</span><br>`;
                ppHtml += protHtmlStored;
            } else if (tieneProteccion) {
                if (f.FechaEntrega && f.Protegido) {
                    protHtmlStored = `<span class="badge-prot"><i class="bi bi-shield-check me-1"></i>Protegido (${f.DiasProteccion}d)</span><br>`;
                } else if (f.FechaEntrega && !f.Protegido) {
                    protHtmlStored = `<span class="badge-pp-expired"><i class="bi bi-shield-x me-1"></i>Prot. ${f.DiasProteccion}d vencida</span><br>`;
                } else {
                    protHtmlStored = `<span class="badge-prot"><i class="bi bi-shield me-1"></i>${f.DiasProteccion}d prot.</span><br>`;
                }
                ppHtml += protHtmlStored;
            }

            if (f.TieneCondicionado && tienePP) {
                ppHtml += `<span class="badge-pp-expired"><i class="bi bi-slash-circle me-1"></i>Sin PP (cond.)</span>`;
            } else if (tienePP) {
                if (f.DescuentoPP > 0) {
                    const montoDesc = f.RestanteUSD * (f.DescuentoPP / 100);
                    ppHtml += `<span class="badge-pp"><i class="bi bi-tag-fill me-1"></i>-${f.DescuentoPP}% PP</span>`;
                    ppHtml += `<span class="sub-monto" style="color:var(--green);">-$${montoDesc.toFixed(2)}</span>`;
                } else if (f.FechaEntrega) {
                    ppHtml += `<span class="badge-pp-expired"><i class="bi bi-x-circle me-1"></i>PP vencido</span>`;
                } else {
                    ppHtml += `<span class="badge-pp"><i class="bi bi-tag me-1"></i>${f.EscalaPorPP1}% (0-${f.EscalaDiasPP1}d)`;
                    if (f.EscalaDiasPP2 && f.EscalaPorPP2) ppHtml += `<br>${f.EscalaPorPP2}% (${f.EscalaDiasPP1+1}-${f.EscalaDiasPP2}d)`;
                    if (f.EscalaDiasPP3 && f.EscalaPorPP3) ppHtml += `<br>${f.EscalaPorPP3}% (${f.EscalaDiasPP2+1}-${f.EscalaDiasPP3}d)`;
                    if (f.EscalaDiasPP4 && f.EscalaPorPP4) ppHtml += `<br>${f.EscalaPorPP4}% (${f.EscalaDiasPP3+1}-${f.EscalaDiasPP4}d)`;
                    ppHtml += `</span>`;
                }
            }

            if (!ppHtml) ppHtml = '<span style="color:var(--text-muted); font-size:0.72rem;">Sin PP</span>';
            ppHtml += `<br><button class="btn-pp-edit" onclick="abrirPPModal(this)" data-doc="${f.Numero}" data-pp-actual="${f.DescuentoPP}"><i class="bi bi-pencil"></i> Editar</button>`;

            row.innerHTML = `
                <td><input type="checkbox" class="form-check-input" onchange="toggleFila(this)"></td>
                <td class="text-start">
                    <strong style="font-size:0.8rem;">${f.Numero}</strong>
                    ${f.Pedido ? `<span style="font-size:0.65rem;color:var(--text-muted);margin-left:4px;">Ped. ${f.Pedido}</span>` : ''}<br>
                    <span style="font-size:0.72rem; color:var(--text-muted);"><i class="bi bi-calendar3 me-1"></i>${f.Fecha}</span>
                </td>
                <td>${entregaHtml}</td>
                <td><span class="chip chip-gray">${f.TasaOrigen.toFixed(2)}</span></td>
                <td>${fMonto(origBs)} Bs<span class="sub-monto">$${f.RestanteUSD.toFixed(2)}</span></td>
                <td class="fw-bold saldo-hoy" style="color:var(--saldo-hoy);">${fMonto(hoyBs)} Bs<span class="sub-monto" style="color:var(--green);">$${f.RestanteUSD.toFixed(2)}</span></td>
                <td style="color:var(--diff-text); font-weight:600;">+${fMonto(dif)} Bs</td>
                <td>${ppHtml}</td>
                <td>
                    <div style="width:150px; margin:0 auto;">
                        <input type="number" class="form-control form-control-sm monto-input mb-1" value="0" step="0.01" disabled oninput="recalcular()">
                        <div class="nota-indicator" style="min-height:1rem; text-align:center; line-height:1;"></div>
                        <input type="text" class="form-control form-control-sm ref-input mb-1" style="font-size:0.68rem;" placeholder="Referencia" disabled>
                        <input type="text" class="form-control form-control-sm obs-input" style="font-size:0.68rem;" placeholder="Comentario" disabled>
                    </div>
                </td>
                <td>
                    <div style="width:135px; margin:0 auto;">
                        <select class="form-select form-select-sm mb-1 sel-mon" disabled onchange="cambiarMonedaFila(this)">
                            <option value="USD">USD ($)</option>
                            <option value="VES">VES (Bs)</option>
                        </select>
                        <select class="form-select form-select-sm sel-met" disabled></select>
                    </div>
                </td>`;
            row.setAttribute('data-prot-html', protHtmlStored);
            tbody.appendChild(row);
            actualizarMetodos(row.querySelector('.sel-met'), 'USD');
        });
        recalcular();
        mostrarToast('Cliente cargado', `${facturas.length} factura(s) pendiente(s)`);
    } catch (_) {
        tbody.innerHTML = '<tr><td colspan="10" class="text-center py-4" style="color:var(--red);">Error al cargar facturas</td></tr>';
    }
}

// --- ABONO FIFO ---
function aplicarAbono(tipo) {
    const tasa = parseFloat(document.getElementById('tasaDia').value);
    let disp = parseFloat(document.getElementById(tipo === 'USD' ? 'abonoGlobalUSD' : 'abonoGlobalVES').value || 0);
    if (disp <= 0) { mostrarToast('Aviso', 'Ingrese un monto valido', 'warning'); return; }
    resetearTabla();
    document.querySelectorAll('#tablaFacturas tr[data-usd]').forEach(row => {
        if (disp <= 0) return;
        const usd = parseFloat(row.getAttribute('data-usd'));
        const pp = parseFloat(row.getAttribute('data-pp') || 0);
        const usdConPP = pp > 0 ? usd * (1 - pp / 100) : usd;
        const chk = row.querySelector('.form-check-input');
        chk.checked = true;
        toggleFila(chk);
        row.querySelector('.sel-mon').value = tipo;
        actualizarMetodos(row.querySelector('.sel-met'), tipo);
        const tasaRow = getTasaEfectiva(row);
        const saldo = tipo === 'USD' ? usdConPP : usdConPP * tasaRow;
        const pago = Math.min(disp, saldo);
        row.querySelector('.monto-input').value = pago.toFixed(2);
        disp -= pago;
    });
    recalcular();
    if (disp > 0) mostrarToast('Aviso', `Sobrante: ${tipo} ${fMonto(disp)}`, 'warning');
}

function limpiarOtroAbono(tipo) {
    document.getElementById(tipo === 'USD' ? 'abonoGlobalUSD' : 'abonoGlobalVES').value = '';
}

function resetearTabla() {
    document.querySelectorAll('#tablaFacturas tr').forEach(row => {
        const chk = row.querySelector('.form-check-input');
        if (chk) { chk.checked = false; row.querySelector('.monto-input').value = 0; toggleFila(chk); }
    });
}

// --- INTERACTIVIDAD ---
function toggleFila(chk) {
    const row = chk.closest('tr');
    row.querySelectorAll('input:not([type="checkbox"]), select').forEach(i => i.disabled = !chk.checked);
    row.classList.toggle('selected-row', chk.checked);
    if (chk.checked && row.querySelector('.monto-input').value == 0) {
        const usd = parseFloat(row.getAttribute('data-usd'));
        const pp = parseFloat(row.getAttribute('data-pp') || 0);
        const usdFinal = pp > 0 ? usd * (1 - pp / 100) : usd;
        const tasa = getTasaEfectiva(row);
        const mon = row.querySelector('.sel-mon').value;
        row.querySelector('.monto-input').value = (mon === 'USD' ? usdFinal : usdFinal * tasa).toFixed(2);
    }
    recalcular();
}

function cambiarMonedaFila(sel) {
    const row = sel.closest('tr');
    const usd = parseFloat(row.getAttribute('data-usd'));
    const pp = parseFloat(row.getAttribute('data-pp') || 0);
    const usdFinal = pp > 0 ? usd * (1 - pp / 100) : usd;
    const tasa = getTasaEfectiva(row);
    row.querySelector('.monto-input').value = (sel.value === 'VES' ? usdFinal * tasa : usdFinal).toFixed(2);
    actualizarMetodos(row.querySelector('.sel-met'), sel.value);
    recalcular();
}

function actualizarMetodos(sel, moneda) {
    sel.innerHTML = config.metodos.filter(m => m.moneda === moneda).map(m => `<option value="${m.id}">${m.nombre}</option>`).join('');
}

function getTasaEfectiva(row) {
    const protActivo = row.getAttribute('data-prot-activo') === '1';
    return protActivo ? parseFloat(row.getAttribute('data-tasa-orig')) : parseFloat(document.getElementById('tasaDia').value);
}

function actualizarTodoPorTasa() {
    const tasa = parseFloat(document.getElementById('tasaDia').value);
    document.querySelectorAll('#tablaFacturas tr[data-usd]').forEach(row => {
        const usd = parseFloat(row.getAttribute('data-usd'));
        const tOrig = parseFloat(row.getAttribute('data-tasa-orig'));
        const protActivo = row.getAttribute('data-prot-activo') === '1';
        const tasaEf = protActivo ? tOrig : tasa;
        const hoyBs = usd * tasaEf;
        const protLabel = protActivo ? ' <span class="badge-prot" style="font-size:0.55rem;">PROT</span>' : '';
        row.querySelector('.saldo-hoy').innerHTML = `${fMonto(hoyBs)} Bs${protLabel}<span class="sub-monto" style="color:var(--green);">$${usd.toFixed(2)}</span>`;
        row.cells[6].innerHTML = `<span style="color:var(--diff-text); font-weight:600;">${protActivo ? '' : '+'}${fMonto(hoyBs - usd * tOrig)} Bs</span>`;
        if (row.querySelector('.form-check-input').checked && row.querySelector('.sel-mon').value === 'VES') {
            const pp = parseFloat(row.getAttribute('data-pp') || 0);
            const usdFinal = pp > 0 ? usd * (1 - pp / 100) : usd;
            row.querySelector('.monto-input').value = (usdFinal * tasaEf).toFixed(2);
        }
    });
    recalcular();
}

function recalcular() {
    let usd = 0, ves = 0, docs = 0;
    document.querySelectorAll('#tablaFacturas tr').forEach(row => {
        const chk = row.querySelector('.form-check-input');
        const notaEl = row.querySelector('.nota-indicator');
        if (chk?.checked) {
            const m = parseFloat(row.querySelector('.monto-input').value || 0);
            const moneda = row.querySelector('.sel-mon').value;
            moneda === 'USD' ? usd += m : ves += m;
            docs++;
            if (notaEl && m > 0) {
                const restUSD = parseFloat(row.getAttribute('data-usd'));
                const tasaOrig = parseFloat(row.getAttribute('data-tasa-orig'));
                const tasaHoy = parseFloat(document.getElementById('tasaDia').value);
                const protActivo = row.getAttribute('data-prot-activo') === '1';
                const pp = parseFloat(row.getAttribute('data-pp') || 0);
                let htmlNotas = '';
                // NC por PP
                if (pp > 0) {
                    const importePP = restUSD * pp / 100 * tasaOrig;
                    if (importePP > 1) htmlNotas += `<span style="color:var(--green);font-size:0.65rem;font-weight:700;">NC PP: Bs ${importePP.toFixed(2)}</span><br>`;
                }
                // Diferencial cambiario
                let dif = 0;
                if (moneda === 'USD') {
                    dif = (m - restUSD * (1 - pp / 100)) * tasaHoy;
                } else {
                    dif = m - restUSD * (1 - pp / 100) * tasaOrig;
                }
                if (Math.abs(dif) > 1) {
                    const tipo = dif < 0 ? 'NC' : 'ND';
                    const color = dif < 0 ? 'var(--green)' : 'var(--red)';
                    htmlNotas += `<span style="color:${color};font-size:0.65rem;font-weight:700;">${tipo} tasa: Bs ${Math.abs(dif).toFixed(2)}</span>`;
                }
                notaEl.innerHTML = htmlNotas;
            } else if (notaEl) notaEl.innerHTML = '';
        } else if (notaEl) notaEl.innerHTML = '';
    });
    document.getElementById('totalUSD').textContent = `$ ${fMonto(usd)}`;
    document.getElementById('totalVES').textContent = `Bs ${fMonto(ves)}`;
    document.getElementById('totalDocs').textContent = docs;
    document.getElementById('btnCobrar').disabled = docs === 0;
}

// --- PROCESAR COBRO ---
function procesarCobro() {
    const cobros = [];
    const fecha = document.getElementById('fechaSistema').value;
    document.querySelectorAll('#tablaFacturas tr').forEach(row => {
        const chk = row.querySelector('.form-check-input');
        if (chk?.checked) {
            const monto = parseFloat(row.querySelector('.monto-input').value || 0);
            if (monto <= 0) return;
            cobros.push({
                documento: row.cells[1].innerText.split('\n')[0].trim(),
                monto, moneda: row.querySelector('.sel-mon').value,
                formaPagoId: row.querySelector('.sel-met').value,
                fpOriginal: row.getAttribute('data-fp'),
                tasaCobro: getTasaEfectiva(row).toString(),
                tasaHoy: parseFloat(document.getElementById('tasaDia').value),
                tasaOrig: parseFloat(row.getAttribute('data-tasa-orig')),
                pp: parseFloat(row.getAttribute('data-pp') || 0),
                protActivo: row.getAttribute('data-prot-activo') === '1',
                montoOriginalUSD: parseFloat(row.getAttribute('data-usd')),
                referencia: row.querySelector('.ref-input').value,
                comentario: row.querySelector('.obs-input').value
            });
        }
    });
    if (!cobros.length) { mostrarToast('Aviso', 'Seleccione al menos un documento', 'warning'); return; }
    const totalUSD = cobros.filter(c => c.moneda === 'USD').reduce((s, c) => s + c.monto, 0);
    const totalVES = cobros.filter(c => c.moneda === 'VES').reduce((s, c) => s + c.monto, 0);
    let html = '<div style="margin-bottom:1rem;">';
    html += `<div class="confirm-line"><span class="confirm-label">Cliente</span><span class="confirm-value">${clienteSeleccionado?.nombre || '-'}</span></div>`;
    html += `<div class="confirm-line"><span class="confirm-label">Fecha</span><span class="confirm-value">${fecha}</span></div>`;
    html += `<div class="confirm-line"><span class="confirm-label">Documentos</span><span class="confirm-value">${cobros.length}</span></div>`;
    if (totalUSD > 0) html += `<div class="confirm-line"><span class="confirm-label">Total USD</span><span class="confirm-value" style="color:var(--green);">$ ${fMonto(totalUSD)}</span></div>`;
    if (totalVES > 0) html += `<div class="confirm-line"><span class="confirm-label">Total VES</span><span class="confirm-value" style="color:var(--text-secondary);">Bs ${fMonto(totalVES)}</span></div>`;
    html += '</div>';
    document.getElementById('confirmBody').innerHTML = html;
    cobrosPendientes = { fechaCobro: fecha, detalles: cobros };
    new bootstrap.Modal(document.getElementById('modalConfirmar')).show();
}

async function ejecutarCobro() {
    if (!cobrosPendientes) return;
    bootstrap.Modal.getInstance(document.getElementById('modalConfirmar')).hide();
    mostrarLoading('Procesando cobro...');
    try {
        const res = await fetch('/api/cobrar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cobrosPendientes) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error');
        ocultarLoading();
        cobrosPendientes = null;
        mostrarToast(data.warning ? 'Advertencia' : 'Cobro exitoso', data.warning || data.message || 'OK', data.warning ? 'warning' : 'success');
        setTimeout(() => location.reload(), 2000);
    } catch (err) { ocultarLoading(); mostrarToast('Error', err.message, 'error'); }
}

// --- HISTORIAL ---
async function cargarHistorial() {
    const tbody = document.getElementById('tablaHistorial');
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-3"><div class="loader-ring mx-auto" style="width:24px;height:24px;border-width:2px;"></div></td></tr>';
    try {
        const desde = document.getElementById('histDesde').value;
        const hasta = document.getElementById('histHasta').value;
        let url = '/api/historial?';
        if (desde) url += `desde=${desde}&`;
        if (hasta) url += `hasta=${hasta}&`;
        const res = await fetch(url);
        if (!res.ok) throw new Error();
        const datos = await res.json();
        if (!datos.length) { tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4" style="color:var(--text-muted)">Sin registros</td></tr>'; return; }
        tbody.innerHTML = datos.map(d => {
            const estado = d.ESTADO === '2' ? '<span class="badge-estado badge-estado-ok">Procesado</span>' : '<span class="badge-estado badge-estado-pend">Pendiente</span>';
            return `<tr>
                <td class="fw-bold">${d.SERIE} - ${d.NUMERO}</td>
                <td>${d.FECHACOBRO ? new Date(d.FECHACOBRO).toLocaleDateString('es-VE') : '-'}</td>
                <td><span class="chip ${d.MONEDA_ISO === 'USD' ? 'chip-green' : 'chip-gray'}">${d.MONEDA_ISO}</span></td>
                <td class="fw-bold">${fMonto(d.IMPORTE)}</td>
                <td>${d.FORMA_PAGO || '-'}</td>
                <td style="color:var(--text-muted);">${d.REFERENCIA || '-'}</td>
                <td>${estado}</td>
                <td style="font-size:0.75rem; color:var(--text-muted);">${d.FECHAPROCESADO ? new Date(d.FECHAPROCESADO).toLocaleString('es-VE') : '-'}</td>
            </tr>`;
        }).join('');
    } catch (_) { tbody.innerHTML = '<tr><td colspan="8" class="text-center py-3" style="color:var(--red);">Error al cargar</td></tr>'; }
}

// --- ADMIN AUTH ---
let adminAuthed = false;
let pendingAdminCb = null;

function checkAdmin(cb) {
    if (adminAuthed) { cb(); return; }
    pendingAdminCb = cb;
    document.getElementById('adminPassInput').value = '';
    new bootstrap.Modal(document.getElementById('modalAdminAuth')).show();
}

async function confirmarAdminAuth() {
    const pass = document.getElementById('adminPassInput').value;
    const r = await fetch('/api/admin/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass }) });
    if (r.ok) {
        adminAuthed = true;
        bootstrap.Modal.getInstance(document.getElementById('modalAdminAuth')).hide();
        if (pendingAdminCb) { pendingAdminCb(); pendingAdminCb = null; }
    } else {
        mostrarToast('Error', 'Clave incorrecta', 'error');
    }
}

// --- PP / PROTECCION EDIT ---
let ppEditRow = null;

function abrirPPModal(btn) { checkAdmin(() => _abrirPPModal(btn)); }

function _abrirPPModal(btn) {
    ppEditRow = btn.closest('tr');
    const doc = btn.getAttribute('data-doc');
    const usd = parseFloat(ppEditRow.getAttribute('data-usd'));
    const ppActual = parseFloat(ppEditRow.getAttribute('data-pp') || 0);
    const protDias = parseInt(ppEditRow.getAttribute('data-prot-dias') || 0);
    const diasEntrega = parseInt(ppEditRow.getAttribute('data-dias-entrega'));
    const protActivo = ppEditRow.getAttribute('data-prot-activo') === '1';

    document.getElementById('ppDocInfo').innerHTML = `<strong>${doc}</strong> — Saldo: $${usd.toFixed(2)}`;
    document.getElementById('ppProtDias').value = protDias || '';
    document.getElementById('ppPorcentaje').value = ppActual > 0 ? ppActual : '';

    let protStatus = '';
    if (protDias > 0 && diasEntrega >= 0) {
        protStatus = protActivo
            ? `<span style="color:#60a5fa;"><i class="bi bi-shield-check me-1"></i>Activa (${diasEntrega}d de ${protDias}d)</span>`
            : `<span style="color:var(--red);"><i class="bi bi-shield-x me-1"></i>Vencida (${diasEntrega}d de ${protDias}d)</span>`;
    } else if (diasEntrega < 0) {
        protStatus = `<span style="color:var(--yellow);"><i class="bi bi-exclamation-triangle me-1"></i>Sin fecha de entrega</span>`;
    }
    document.getElementById('ppProtStatus').innerHTML = protStatus;

    const descInfo = ppActual > 0 ? `Ahorro: -$${(usd * ppActual / 100).toFixed(2)}` : '';
    document.getElementById('ppDescInfo').innerHTML = descInfo;

    document.getElementById('ppPorcentaje').oninput = function() {
        const v = parseFloat(this.value || 0);
        document.getElementById('ppDescInfo').innerHTML = v > 0 ? `Ahorro: -$${(usd * v / 100).toFixed(2)}` : '';
    };

    new bootstrap.Modal(document.getElementById('modalPP')).show();
}

function aplicarPPModal() {
    if (!ppEditRow) return;
    const pp = parseFloat(document.getElementById('ppPorcentaje').value || 0);
    const protDias = parseInt(document.getElementById('ppProtDias').value || 0);
    if (pp < 0 || pp > 100) { mostrarToast('Error', 'Porcentaje entre 0 y 100', 'error'); return; }

    actualizarProteccion(ppEditRow, protDias);
    actualizarPPFila(ppEditRow, pp);
    bootstrap.Modal.getInstance(document.getElementById('modalPP')).hide();
    mostrarToast('Actualizado', 'Condiciones de cobro actualizadas');
}

function desactivarPPModal() {
    if (!ppEditRow) return;
    const protDias = parseInt(document.getElementById('ppProtDias').value || 0);
    actualizarProteccion(ppEditRow, protDias);
    actualizarPPFila(ppEditRow, 0);
    bootstrap.Modal.getInstance(document.getElementById('modalPP')).hide();
    mostrarToast('PP removido', 'Descuento de pronto pago desactivado');
}

function desactivarProtModal() {
    if (!ppEditRow) return;
    const pp = parseFloat(document.getElementById('ppPorcentaje').value || 0);
    actualizarProteccion(ppEditRow, 0);
    actualizarPPFila(ppEditRow, pp);
    bootstrap.Modal.getInstance(document.getElementById('modalPP')).hide();
    mostrarToast('Proteccion removida', 'Dias protegidos desactivados');
}

function desactivarTodoModal() {
    if (!ppEditRow) return;
    actualizarProteccion(ppEditRow, 0);
    actualizarPPFila(ppEditRow, 0);
    bootstrap.Modal.getInstance(document.getElementById('modalPP')).hide();
    mostrarToast('Desactivado', 'PP y proteccion removidos');
}

function actualizarProteccion(row, dias) {
    row.setAttribute('data-prot-dias', dias);
    const diasEntrega = parseInt(row.getAttribute('data-dias-entrega'));
    const protActivo = dias > 0 && diasEntrega >= 0 && diasEntrega <= dias;
    row.setAttribute('data-prot-activo', protActivo ? '1' : '0');

    let protBadgeHtml = '';
    if (dias > 0) {
        if (diasEntrega < 0) {
            protBadgeHtml = `<span class="badge-prot"><i class="bi bi-shield me-1"></i>${dias}d prot.</span><br>`;
        } else if (protActivo) {
            protBadgeHtml = `<span class="badge-prot"><i class="bi bi-shield-check me-1"></i>Protegido (${dias}d)</span><br>`;
        } else {
            protBadgeHtml = `<span class="badge-pp-expired"><i class="bi bi-shield-x me-1"></i>Prot. ${dias}d vencida</span><br>`;
        }
    }
    row.setAttribute('data-prot-html', protBadgeHtml);
    actualizarTodoPorTasa();
}

function actualizarPPFila(row, pp) {
    row.setAttribute('data-pp', pp);
    const usd = parseFloat(row.getAttribute('data-usd'));
    const ppCell = row.cells[7];
    const protHtml = row.getAttribute('data-prot-html') || '';

    let ppBadge = '';
    if (pp > 0) {
        ppBadge = `<span class="badge-pp"><i class="bi bi-tag-fill me-1"></i>-${pp}% PP</span><span class="sub-monto" style="color:var(--green);">-$${(usd * pp / 100).toFixed(2)}</span>`;
    } else {
        ppBadge = '<span style="color:var(--text-muted); font-size:0.72rem;">Sin PP</span>';
    }
    const doc = row.cells[1].innerText.split('\n')[0].trim();
    ppCell.innerHTML = protHtml + ppBadge + `<br><button class="btn-pp-edit" onclick="abrirPPModal(this)" data-doc="${doc}"><i class="bi bi-pencil"></i> Editar</button>`;

    if (row.querySelector('input[type=checkbox]')?.checked) {
        const tasa = getTasaEfectiva(row);
        const mon = row.querySelector('.sel-mon').value;
        const usdFinal = pp > 0 ? usd * (1 - pp / 100) : usd;
        row.querySelector('.monto-input').value = (mon === 'USD' ? usdFinal : usdFinal * tasa).toFixed(2);
        recalcular();
    }
}
