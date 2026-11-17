// Subject catalogue: create, rename, delete, and CSV import
(function () {
    'use strict';

    const state = {
        subjects: [],
        editingId: null,
        csvRows: []
    };

    const el = id => document.getElementById(id);

    function canManage() {
        return !!(window.verotAuth && window.verotAuth.can('subjects'));
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function toast(message, type = 'info') {
        if (window.proctoringApp && typeof window.proctoringApp.showMessage === 'function') {
            window.proctoringApp.showMessage(message, type);
            return;
        }
        console.log(message);
    }

    async function api(url, options = {}) {
        const response = await fetch(url, {
            headers: { 'Content-Type': 'application/json' },
            ...options
        });
        let payload = null;
        try {
            payload = await response.json();
        } catch (error) {
            payload = null;
        }
        if (!response.ok || (payload && payload.success === false)) {
            throw new Error((payload && payload.error) || `Request failed (${response.status})`);
        }
        return payload;
    }

    function notifyCatalogChanged() {
        document.dispatchEvent(new CustomEvent('verot:subjects-changed'));
    }

    async function loadSubjects() {
        const list = el('subjectList');
        if (!list) return;
        try {
            const data = await api('/api/subjects');
            state.subjects = data.subjects || [];
            renderSubjects();
        } catch (error) {
            list.innerHTML = `<div class="team-empty"><i class="fas fa-lock"></i><p>${escapeHtml(error.message)}</p></div>`;
        }
    }

    function renderSubjects() {
        const list = el('subjectList');
        if (!list) return;
        if (el('subjectCount')) el('subjectCount').textContent = state.subjects.length;

        if (!state.subjects.length) {
            list.innerHTML = `
                <div class="team-empty">
                    <i class="fas fa-layer-group"></i>
                    <h3>No subjects yet</h3>
                    <p>Add a subject or import a CSV before writing questions.</p>
                </div>`;
            return;
        }

        const manage = canManage();
        list.innerHTML = `<div class="roster-table-wrap"><table class="roster-table">
            <thead><tr><th>Subject</th><th>Code</th><th>Questions</th><th></th></tr></thead>
            <tbody>${state.subjects.map(subject => `<tr>
                <td><strong>${escapeHtml(subject.name)}</strong></td>
                <td><code>${escapeHtml(subject.code)}</code></td>
                <td>${subject.questionCount || 0}</td>
                <td class="subject-row-actions">
                    <button type="button" class="link-btn" data-subject-edit="${escapeHtml(subject.id)}" ${manage ? '' : 'disabled'} title="Edit subject">
                        <i class="fas fa-pen"></i>
                    </button>
                    <button type="button" class="link-btn danger" data-subject-delete="${escapeHtml(subject.id)}" ${manage ? '' : 'disabled'} title="Delete subject">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            </tr>`).join('')}</tbody>
        </table></div>`;
    }

    function openSubjectModal(subject = null) {
        state.editingId = subject ? subject.id : null;
        if (el('subjectModalTitle')) {
            el('subjectModalTitle').innerHTML = subject
                ? '<i class="fas fa-pen"></i> Edit subject'
                : '<i class="fas fa-layer-group"></i> New subject';
        }
        if (el('subjectName')) el('subjectName').value = subject ? subject.name : '';
        if (el('subjectCode')) el('subjectCode').value = subject ? subject.code : '';
        if (el('subjectError')) {
            el('subjectError').textContent = '';
            el('subjectError').classList.add('hidden');
        }
        el('subjectModal')?.classList.remove('hidden');
        setTimeout(() => el('subjectName')?.focus(), 50);
    }

    function closeSubjectModal() {
        el('subjectModal')?.classList.add('hidden');
        state.editingId = null;
    }

    async function saveSubject(event) {
        event.preventDefault();
        const name = el('subjectName').value.trim();
        const code = el('subjectCode').value.trim().toUpperCase();
        const errorBox = el('subjectError');

        const showError = message => {
            if (!errorBox) return toast(`❌ ${message}`, 'error');
            errorBox.textContent = message;
            errorBox.classList.remove('hidden');
        };

        if (!name) return showError('Subject name is required');
        if (!code) return showError('Subject code is required');

        const submitBtn = el('subjectForm').querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;

        try {
            if (state.editingId) {
                await api(`/api/subjects/${encodeURIComponent(state.editingId)}`, {
                    method: 'PUT',
                    body: JSON.stringify({ name, code })
                });
                toast('✅ Subject updated', 'success');
            } else {
                await api('/api/subjects', {
                    method: 'POST',
                    body: JSON.stringify({ name, code })
                });
                toast('✅ Subject created', 'success');
            }
            closeSubjectModal();
            await loadSubjects();
            notifyCatalogChanged();
        } catch (error) {
            showError(error.message);
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    }

    async function removeSubject(id) {
        const subject = state.subjects.find(item => item.id === id);
        if (!subject) return;
        if (!window.confirm(`Delete ${subject.name} (${subject.code})?`)) return;
        try {
            await api(`/api/subjects/${encodeURIComponent(id)}`, { method: 'DELETE' });
            toast('Subject deleted', 'success');
            await loadSubjects();
            notifyCatalogChanged();
        } catch (error) {
            toast(`❌ ${error.message}`, 'error');
        }
    }

    // ==================== CSV IMPORT ====================

    function parseCsv(text) {
        const source = String(text || '').replace(/^\uFEFF/, '');
        const rows = [];
        let row = [];
        let field = '';
        let inQuotes = false;

        for (let index = 0; index < source.length; index += 1) {
            const char = source[index];
            if (inQuotes) {
                if (char === '"') {
                    if (source[index + 1] === '"') {
                        field += '"';
                        index += 1;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    field += char;
                }
                continue;
            }
            if (char === '"') {
                inQuotes = true;
            } else if (char === ',') {
                row.push(field);
                field = '';
            } else if (char === '\n') {
                row.push(field);
                rows.push(row);
                row = [];
                field = '';
            } else if (char !== '\r') {
                field += char;
            }
        }
        if (field.length || row.length) {
            row.push(field);
            rows.push(row);
        }
        return rows.filter(cells => cells.some(cell => cell.trim() !== ''));
    }

    function headerKey(value) {
        return String(value || '').toLowerCase().replace(/[^a-z]/g, '');
    }

    function mapCsvRows(rows) {
        if (!rows.length) throw new Error('The file is empty');
        const headers = rows[0].map(headerKey);
        const nameIndex = headers.findIndex(key => ['subjectname', 'name', 'subject'].includes(key));
        const codeIndex = headers.findIndex(key => ['subjectcode', 'code', 'shortcode'].includes(key));

        if (nameIndex === -1 || codeIndex === -1) {
            throw new Error('The CSV needs subjectname and subjectcode columns');
        }

        const subjects = [];
        const problems = [];
        for (let index = 1; index < rows.length; index += 1) {
            const cells = rows[index];
            const name = (cells[nameIndex] || '').trim();
            const code = (cells[codeIndex] || '').trim().toUpperCase();
            if (!name && !code) continue;
            if (!name || !code) {
                problems.push(`Row ${index + 1}: subjectname and subjectcode are both required`);
                continue;
            }
            subjects.push({ name, code });
        }

        return { subjects, problems };
    }

    function renderImportSummary(message, type = '') {
        const box = el('subjectImportSummary');
        if (!box) return;
        box.className = `import-summary ${type}`.trim();
        box.innerHTML = message;
        box.classList.toggle('hidden', !message);
    }

    async function onCsvSelected(file) {
        state.csvRows = [];
        const importBtn = el('subjectCsvImport');
        if (importBtn) importBtn.disabled = true;
        renderImportSummary('');

        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
            renderImportSummary('<i class="fas fa-triangle-exclamation"></i> Keep the CSV under 2 MB.', 'error');
            return;
        }

        try {
            const rows = parseCsv(await file.text());
            const { subjects, problems } = mapCsvRows(rows);
            if (!subjects.length) throw new Error(problems[0] || 'No subject rows found');

            state.csvRows = subjects;
            const warning = problems.length
                ? `<div class="import-warning">${problems.slice(0, 3).map(problem => escapeHtml(problem)).join('<br>')}</div>`
                : '';
            renderImportSummary(
                `<i class="fas fa-file-csv"></i> <strong>${subjects.length}</strong> subjects ready from ${escapeHtml(file.name)}.${warning}`,
                'ready'
            );
            if (importBtn) importBtn.disabled = false;
        } catch (error) {
            renderImportSummary(`<i class="fas fa-triangle-exclamation"></i> ${escapeHtml(error.message)}`, 'error');
        }
    }

    async function importSubjects() {
        if (!state.csvRows.length) return;
        const importBtn = el('subjectCsvImport');
        if (importBtn) importBtn.disabled = true;

        try {
            const data = await api('/api/subjects/import', {
                method: 'POST',
                body: JSON.stringify({ subjects: state.csvRows })
            });
            const summary = data.summary || {};
            const errors = (summary.errors || []).slice(0, 4)
                .map(error => `Row ${error.row}: ${escapeHtml(error.message)}`)
                .join('<br>');

            renderImportSummary(
                `<i class="fas fa-circle-check"></i> <strong>${summary.created || 0}</strong> added, ` +
                `<strong>${summary.updated || 0}</strong> updated, ` +
                `<strong>${summary.unchanged || 0}</strong> unchanged` +
                (summary.skipped ? `, <strong>${summary.skipped}</strong> skipped` : '') +
                (errors ? `<div class="import-warning">${errors}</div>` : ''),
                summary.skipped ? 'warn' : 'success'
            );

            state.csvRows = [];
            if (el('subjectCsvInput')) el('subjectCsvInput').value = '';
            await loadSubjects();
            notifyCatalogChanged();
            toast('✅ Subject list updated', 'success');
        } catch (error) {
            renderImportSummary(`<i class="fas fa-triangle-exclamation"></i> ${escapeHtml(error.message)}`, 'error');
        } finally {
            if (importBtn) importBtn.disabled = !state.csvRows.length;
        }
    }

    function downloadTemplate() {
        const csv = 'subjectname,subjectcode\nBiology,BIO-101\nMathematics,MAT-101\n';
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'subject-template.csv';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ==================== BOOTSTRAP ====================

    function bind() {
        el('newSubjectBtn')?.addEventListener('click', () => openSubjectModal());
        el('subjectForm')?.addEventListener('submit', saveSubject);
        el('subjectCancelBtn')?.addEventListener('click', closeSubjectModal);
        el('subjectList')?.addEventListener('click', event => {
            const edit = event.target.closest('[data-subject-edit]');
            if (edit) {
                const subject = state.subjects.find(item => item.id === edit.dataset.subjectEdit);
                if (subject) openSubjectModal(subject);
                return;
            }
            const remove = event.target.closest('[data-subject-delete]');
            if (remove) removeSubject(remove.dataset.subjectDelete);
        });
        el('subjectCsvInput')?.addEventListener('change', event => {
            onCsvSelected(event.target.files && event.target.files[0]);
        });
        el('subjectCsvImport')?.addEventListener('click', importSubjects);
        el('subjectCsvTemplate')?.addEventListener('click', downloadTemplate);
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            if (el('subjectModal') && !el('subjectModal').classList.contains('hidden')) {
                closeSubjectModal();
            }
        });
    }

    async function init() {
        if (!el('subjectList') || !window.verotAuth) return;
        await window.verotAuth.ready;
        if (!canManage()) return;
        bind();
        loadSubjects();
    }

    window.subjectCatalog = { reload: loadSubjects };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
