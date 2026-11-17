// Company session, access gating, team management, and student roster
(function () {
    'use strict';

    const PERMISSION_LABELS = {
        invigilation: 'Invigilation',
        questions: 'Create exam questions',
        subjects: 'Manage subjects',
        quizzes: 'Create quizzes',
        users: 'Create users',
        students: 'Upload students'
    };

    const state = {
        kind: null,
        user: null,
        company: null,
        permissions: [],
        isAdmin: false,
        team: [],
        students: [],
        editingTeamId: null,
        csvRows: [],
        csvFileName: ''
    };

    const el = id => document.getElementById(id);

    const auth = {
        ready: null,
        state,
        get user() { return state.user; },
        get company() { return state.company; },
        get permissions() { return state.permissions.slice(); },
        get isAdmin() { return state.isAdmin; },
        isStaff() { return state.kind === 'staff'; },
        isStudent() { return state.kind === 'student'; },
        can(permission) {
            if (state.kind !== 'staff') return false;
            if (state.isAdmin) return true;
            return state.permissions.includes(permission);
        },
        preferredWorkspace: null,
        async logout() {
            try {
                await api('/api/auth/logout', { method: 'POST' });
            } catch (error) {
                // The cookie is cleared server-side even if the request races a reload
            }
            window.location.href = '/login.html';
        }
    };
    window.verotAuth = auth;

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
            const error = new Error((payload && payload.error) || `Request failed (${response.status})`);
            error.status = response.status;
            throw error;
        }
        return payload;
    }

    function onReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn);
        } else {
            fn();
        }
    }

    function initials(name) {
        const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return '?';
        return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
    }

    function roleLabel(user) {
        return user.isAdmin ? 'Admin' : 'Member';
    }

    function permissionChips(user) {
        if (user.isAdmin) {
            return '<span class="perm-chip perm-chip-admin">Full access</span>';
        }
        if (!user.permissions || !user.permissions.length) {
            return '<span class="perm-chip perm-chip-muted">No access</span>';
        }
        return user.permissions
            .map(permission => `<span class="perm-chip">${escapeHtml(PERMISSION_LABELS[permission] || permission)}</span>`)
            .join('');
    }

    function applyHeader() {
        const chip = el('accountChip');
        if (!chip) return;
        chip.classList.remove('hidden');

        if (el('accountName')) el('accountName').textContent = state.user.name;
        if (el('accountCompany')) el('accountCompany').textContent = state.company.name;
        if (el('accountRole')) {
            el('accountRole').textContent = roleLabel({ isAdmin: state.isAdmin });
            el('accountRole').className = `role-badge ${state.isAdmin ? 'admin' : 'member'}`;
        }
        if (el('accountInitial')) el('accountInitial').textContent = initials(state.user.name);
    }

    function hideWithoutPermission(node, permission) {
        const list = String(permission || '').split(',').map(item => item.trim()).filter(Boolean);
        const allowed = list.length === 0 || list.some(item => auth.can(item));
        node.classList.toggle('hidden', !allowed);
        if (!allowed && node.hasAttribute('data-permission-tab')) {
            node.setAttribute('aria-selected', 'false');
        }
    }

    function applyPermissionGates() {
        document.querySelectorAll('[data-permission]').forEach(node => {
            hideWithoutPermission(node, node.dataset.permission);
        });
        document.querySelectorAll('[data-permission-tab]').forEach(node => {
            hideWithoutPermission(node, node.dataset.permissionTab);
        });

        if (!auth.can('invigilation')) {
            const candidateTabs = [...document.querySelectorAll('[data-permission-tab]')]
                .filter(tab => !tab.classList.contains('hidden') && tab.dataset.workspace !== 'live');
            const preferred = candidateTabs.find(tab => tab.dataset.workspace === 'bank')
                || candidateTabs.find(tab => tab.dataset.workspace === 'exams')
                || candidateTabs[0];
            if (preferred) auth.preferredWorkspace = preferred.dataset.workspace;
        }
    }

    // ==================== TEAM ====================

    async function loadTeam() {
        try {
            const data = await api('/api/team');
            state.team = data.users || [];
            renderTeam();
        } catch (error) {
            const list = el('teamList');
            if (list) {
                list.innerHTML = `<div class="team-empty"><i class="fas fa-lock"></i><p>${escapeHtml(error.message)}</p></div>`;
            }
        }
    }

    function renderTeam() {
        const list = el('teamList');
        if (!list) return;

        const selfId = state.user ? state.user.id : '';
        if (!state.team.length) {
            list.innerHTML = `
                <div class="team-empty">
                    <i class="fas fa-users-gear"></i>
                    <h3>No team members yet</h3>
                    <p>Add colleagues and choose which parts of the portal they can use.</p>
                </div>`;
            return;
        }

        list.innerHTML = state.team.map(user => {
            const isSelf = user.id === selfId;
            const canManage = state.isAdmin || (!user.isAdmin && user.permissions.every(
                permission => auth.can(permission)
            ));
            return `<div class="team-row">
                <div class="team-avatar">${escapeHtml(initials(user.name))}</div>
                <div class="team-identity">
                    <strong>${escapeHtml(user.name)}${isSelf ? ' <span class="self-tag">you</span>' : ''}</strong>
                    <span class="team-email">${escapeHtml(user.email)}</span>
                    <div class="perm-chips">${permissionChips(user)}</div>
                </div>
                <span class="role-badge ${user.isAdmin ? 'admin' : 'member'}">${user.isAdmin ? 'Admin' : 'Member'}</span>
                <div class="team-actions">
                    <button type="button" class="link-btn" data-team-edit="${escapeHtml(user.id)}" ${canManage ? '' : 'disabled'}>
                        <i class="fas fa-pen"></i> Edit
                    </button>
                    <button type="button" class="link-btn danger" data-team-delete="${escapeHtml(user.id)}" ${canManage && !isSelf ? '' : 'disabled'}>
                        <i class="fas fa-trash"></i> Remove
                    </button>
                </div>
            </div>`;
        }).join('');
    }

    function setTeamRoleUI() {
        const role = el('teamRole') ? el('teamRole').value : 'member';
        const permissionsBox = el('teamPermissions');
        if (permissionsBox) {
            const isAdminRole = role === 'admin';
            permissionsBox.classList.toggle('disabled', isAdminRole);
            permissionsBox.querySelectorAll('input').forEach(input => {
                input.disabled = isAdminRole || input.dataset.locked === 'true';
            });
        }
        if (el('teamRoleHint')) {
            el('teamRoleHint').textContent = role === 'admin'
                ? 'Administrators can do everything and assign other administrators.'
                : 'Choose exactly what this person can open and change.';
        }
        if (el('teamPassword')) {
            el('teamPassword').required = !state.editingTeamId;
        }
    }

    function openTeamModal(user = null) {
        state.editingTeamId = user ? user.id : null;
        if (el('teamModalTitle')) {
            el('teamModalTitle').textContent = user ? 'Edit team user' : 'Add team user';
        }
        if (el('teamName')) el('teamName').value = user ? user.name : '';
        if (el('teamEmail')) el('teamEmail').value = user ? user.email : '';
        if (el('teamPassword')) {
            el('teamPassword').value = '';
            el('teamPassword').placeholder = user ? 'Leave blank to keep current password' : 'At least 8 characters';
            el('teamPassword').required = !user;
        }
        if (el('teamRole')) {
            el('teamRole').value = user && user.isAdmin ? 'admin' : 'member';
        }

        const granted = new Set(user ? user.permissions : []);
        document.querySelectorAll('#teamPermissions input[type="checkbox"]').forEach(input => {
            input.checked = input.value === 'admin' ? !!user && user.isAdmin : granted.has(input.value);
            const locked = !state.isAdmin && !auth.can(input.value);
            input.dataset.locked = locked ? 'true' : 'false';
            input.disabled = locked || (user && user.isAdmin);
        });

        if (el('teamRole')) {
            const adminOption = el('teamRole').querySelector('option[value="admin"]');
            if (adminOption) adminOption.disabled = !state.isAdmin;
            el('teamRole').disabled = !!user && user.isAdmin && user.id === (state.user && state.user.id);
            el('teamRole').value = user && user.isAdmin ? 'admin' : 'member';
        }

        if (el('teamError')) {
            el('teamError').textContent = '';
            el('teamError').classList.add('hidden');
        }
        setTeamRoleUI();
        el('teamModal')?.classList.remove('hidden');
        setTimeout(() => el('teamName')?.focus(), 50);
    }

    function closeTeamModal() {
        el('teamModal')?.classList.add('hidden');
        state.editingTeamId = null;
    }

    async function saveTeamUser(event) {
        event.preventDefault();
        const name = el('teamName').value.trim();
        const email = el('teamEmail').value.trim();
        const password = el('teamPassword').value;
        const role = el('teamRole').value;
        const permissions = [...document.querySelectorAll('#teamPermissions input[type="checkbox"]:checked')]
            .filter(input => input.value !== 'admin')
            .map(input => input.value);

        const errorBox = el('teamError');
        const showError = message => {
            if (!errorBox) return toast(`❌ ${message}`, 'error');
            errorBox.textContent = message;
            errorBox.classList.remove('hidden');
        };

        if (!name || !email) return showError('Name and email are required');
        if (!state.editingTeamId && password.length < 8) return showError('Password must be at least 8 characters');
        if (role === 'member' && !permissions.length) return showError('Choose at least one access permission');

        const body = { name, email, role, permissions };
        if (password) body.password = password;

        const submitBtn = el('teamSaveBtn');
        if (submitBtn) submitBtn.disabled = true;
        try {
            if (state.editingTeamId) {
                await api(`/api/team/${encodeURIComponent(state.editingTeamId)}`, {
                    method: 'PATCH',
                    body: JSON.stringify(body)
                });
                toast('✅ Team user updated', 'success');
            } else {
                await api('/api/team', {
                    method: 'POST',
                    body: JSON.stringify(body)
                });
                toast('✅ Team user added', 'success');
            }
            closeTeamModal();
            await loadTeam();
        } catch (error) {
            showError(error.message);
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    }

    async function removeTeamUser(id) {
        const user = state.team.find(item => item.id === id);
        if (!user) return;
        if (!window.confirm(`Remove ${user.name} from this institution?`)) return;
        try {
            await api(`/api/team/${encodeURIComponent(id)}`, { method: 'DELETE' });
            toast('Team user removed', 'success');
            await loadTeam();
        } catch (error) {
            toast(`❌ ${error.message}`, 'error');
        }
    }

    function bindTeam() {
        el('addTeamUserBtn')?.addEventListener('click', () => openTeamModal());
        el('teamForm')?.addEventListener('submit', saveTeamUser);
        el('teamCancelBtn')?.addEventListener('click', closeTeamModal);
        el('teamRole')?.addEventListener('change', setTeamRoleUI);
        el('teamList')?.addEventListener('click', event => {
            const edit = event.target.closest('[data-team-edit]');
            if (edit) {
                const user = state.team.find(item => item.id === edit.dataset.teamEdit);
                if (user) openTeamModal(user);
                return;
            }
            const remove = event.target.closest('[data-team-delete]');
            if (remove) removeTeamUser(remove.dataset.teamDelete);
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && el('teamModal') && !el('teamModal').classList.contains('hidden')) {
                closeTeamModal();
            }
        });
    }

    // ==================== STUDENT ROSTER ====================

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
        const nameIndex = headers.findIndex(key => ['fullname', 'name', 'studentname'].includes(key));
        const numberIndex = headers.findIndex(key => ['studentnumber', 'studentno', 'studentid', 'number'].includes(key));
        const emailIndex = headers.findIndex(key => key === 'email' || key === 'emailaddress');

        if (nameIndex === -1 || numberIndex === -1 || emailIndex === -1) {
            throw new Error('The CSV needs fullname, studentnumber, and email columns');
        }

        const students = [];
        const problems = [];
        for (let index = 1; index < rows.length; index += 1) {
            const cells = rows[index];
            const fullName = (cells[nameIndex] || '').trim();
            const studentNumber = (cells[numberIndex] || '').trim();
            const email = (cells[emailIndex] || '').trim();
            if (!fullName && !studentNumber && !email) continue;
            if (!fullName || !studentNumber || !email) {
                problems.push(`Row ${index + 1}: fullname, studentnumber, and email are all required`);
                continue;
            }
            students.push({ fullName, studentNumber, email });
        }

        return { students, problems };
    }

    function renderImportSummary(message, type = '') {
        const box = el('studentImportSummary');
        if (!box) return;
        box.className = `import-summary ${type}`.trim();
        box.innerHTML = message;
        box.classList.remove('hidden');
    }

    async function onCsvSelected(file) {
        state.csvRows = [];
        state.csvFileName = '';
        if (!file) return;
        const importBtn = el('studentCsvImport');
        if (importBtn) importBtn.disabled = true;
        renderImportSummary('');

        if (file.size > 2 * 1024 * 1024) {
            renderImportSummary('<i class="fas fa-triangle-exclamation"></i> Keep the CSV under 2 MB.', 'error');
            return;
        }

        try {
            const text = await file.text();
            const rows = parseCsv(text);
            const { students, problems } = mapCsvRows(rows);
            if (!students.length) {
                throw new Error(problems[0] || 'No student rows found');
            }
            state.csvRows = students;
            state.csvFileName = file.name;
            const warning = problems.length
                ? `<div class="import-warning">${problems.slice(0, 3).map(problem => escapeHtml(problem)).join('<br>')}</div>`
                : '';
            renderImportSummary(
                `<i class="fas fa-file-csv"></i> <strong>${students.length}</strong> students ready from ${escapeHtml(file.name)}.${warning}`,
                'ready'
            );
            if (importBtn) importBtn.disabled = false;
        } catch (error) {
            renderImportSummary(`<i class="fas fa-triangle-exclamation"></i> ${escapeHtml(error.message)}`, 'error');
        }
    }

    async function importStudents() {
        if (!state.csvRows.length) return;
        const importBtn = el('studentCsvImport');
        if (importBtn) importBtn.disabled = true;
        try {
            const data = await api('/api/students/import', {
                method: 'POST',
                body: JSON.stringify({ students: state.csvRows })
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
            const input = el('studentCsvInput');
            if (input) input.value = '';
            await loadStudents();
            toast('✅ Student register updated', 'success');
        } catch (error) {
            renderImportSummary(`<i class="fas fa-triangle-exclamation"></i> ${escapeHtml(error.message)}`, 'error');
        } finally {
            if (importBtn) importBtn.disabled = !state.csvRows.length;
        }
    }

    function downloadTemplate() {
        const csv = 'fullname,studentnumber,email\nAda Lovelace,STU-001,ada@example.edu\nAlan Turing,STU-002,alan@example.edu\n';
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'student-template.csv';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function loadStudents() {
        const list = el('studentRosterList');
        if (!list) return;
        const search = el('studentRosterSearch') ? el('studentRosterSearch').value.trim() : '';
        try {
            const data = await api(`/api/students?search=${encodeURIComponent(search)}`);
            state.students = data.students || [];
            renderStudents();
        } catch (error) {
            list.innerHTML = `<div class="team-empty"><i class="fas fa-lock"></i><p>${escapeHtml(error.message)}</p></div>`;
        }
    }

    function renderStudents() {
        const list = el('studentRosterList');
        if (!list) return;
        if (el('studentRosterCount')) el('studentRosterCount').textContent = state.students.length;
        if (el('studentRosterTabCount')) el('studentRosterTabCount').textContent = state.students.length;

        if (!state.students.length) {
            const search = el('studentRosterSearch') ? el('studentRosterSearch').value.trim() : '';
            list.innerHTML = `
                <div class="team-empty">
                    <i class="fas fa-user-graduate"></i>
                    <h3>${search ? 'No matching students' : 'No students yet'}</h3>
                    <p>${search ? 'Try a different name, number, or email.' : 'Upload a CSV to allow students to sit exams.'}</p>
                </div>`;
            return;
        }

        list.innerHTML = `<div class="roster-table-wrap"><table class="roster-table">
            <thead><tr><th>Student</th><th>Number</th><th>Email</th><th></th></tr></thead>
            <tbody>${state.students.map(student => `<tr>
                <td><strong>${escapeHtml(student.fullName)}</strong></td>
                <td><code>${escapeHtml(student.studentNumber)}</code></td>
                <td>${escapeHtml(student.email)}</td>
                <td><button type="button" class="link-btn danger" data-student-delete="${escapeHtml(student.id)}" title="Remove student">
                    <i class="fas fa-trash"></i></button></td>
            </tr>`).join('')}</tbody>
        </table></div>`;
    }

    async function removeStudent(id) {
        const student = state.students.find(item => item.id === id);
        if (!student) return;
        if (!window.confirm(`Remove ${student.fullName} from the register?`)) return;
        try {
            await api(`/api/students/${encodeURIComponent(id)}`, { method: 'DELETE' });
            toast('Student removed', 'success');
            await loadStudents();
        } catch (error) {
            toast(`❌ ${error.message}`, 'error');
        }
    }

    function bindStudents() {
        el('studentCsvInput')?.addEventListener('change', event => {
            onCsvSelected(event.target.files && event.target.files[0]);
        });
        el('studentCsvImport')?.addEventListener('click', importStudents);
        el('studentCsvTemplate')?.addEventListener('click', downloadTemplate);
        el('studentRosterSearch')?.addEventListener('input', () => {
            clearTimeout(state.searchTimer);
            state.searchTimer = setTimeout(loadStudents, 250);
        });
        el('studentRosterList')?.addEventListener('click', event => {
            const button = event.target.closest('[data-student-delete]');
            if (button) removeStudent(button.dataset.studentDelete);
        });
    }

    // ==================== STUDENT PORTAL HELPERS ====================

    function applyStudentSession(data) {
        const student = data.student;
        if (!student) return;
        if (el('studentNumber') && !el('studentNumber').value) {
            el('studentNumber').value = student.studentNumber || '';
        }
        if (el('studentEmail') && !el('studentEmail').value) {
            el('studentEmail').value = student.email || '';
        }
        if (el('studentRoomHint')) {
            const roomId = new URLSearchParams(window.location.search).get('room')
                || (el('studentRoomId') && el('studentRoomId').value) || '';
            if (roomId) updateRoomHint(roomId);
            el('studentRoomHint').classList.remove('hidden');
        }
    }

    async function updateRoomHint(roomId) {
        const hint = el('studentRoomHint');
        if (!hint) return;
        if (!roomId) {
            hint.classList.add('hidden');
            return;
        }
        hint.classList.remove('hidden');
        hint.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking session…';
        try {
            const data = await api(`/api/validate-room/${encodeURIComponent(roomId)}`);
            hint.innerHTML = `<i class="fas fa-building-columns"></i> <strong>${escapeHtml(data.companyName || 'Institution')}</strong>` +
                (data.description ? ` &middot; ${escapeHtml(data.description)}` : '');
        } catch (error) {
            hint.innerHTML = `<i class="fas fa-triangle-exclamation"></i> ${escapeHtml(error.message)}`;
        }
    }

    function bindStudentPortal() {
        const roomInput = el('studentRoomId');
        if (roomInput) {
            roomInput.addEventListener('change', () => updateRoomHint(roomInput.value.trim().toUpperCase()));
            const initial = new URLSearchParams(window.location.search).get('room') || roomInput.value;
            if (initial) updateRoomHint(initial.trim().toUpperCase());
        }
        el('studentSignOutBtn')?.addEventListener('click', async () => {
            try {
                await api('/api/student/logout', { method: 'POST' });
            } catch (error) {
                // Clearing the local details is enough to try another student
            }
            ['candidateRoom', 'candidateUserId', 'candidateName', 'candidateMedia',
                'candidateNumber', 'candidateEmail'].forEach(key => localStorage.removeItem(key));
            if (el('studentNumber')) el('studentNumber').value = '';
            if (el('studentEmail')) el('studentEmail').value = '';
            toast('Student details cleared', 'info');
        });
    }

    // ==================== BOOTSTRAP ====================

    function applyStaffSession(data) {
        state.kind = 'staff';
        state.user = data.user;
        state.company = data.company;
        state.permissions = data.permissions || [];
        state.isAdmin = !!data.isAdmin;

        applyHeader();
        applyPermissionGates();

        if (el('userName')) {
            el('userName').value = state.user.name;
        }

        if (auth.can('users')) {
            bindTeam();
            loadTeam();
        }
        if (auth.can('students')) {
            bindStudents();
            loadStudents();
        }

        el('logoutBtn')?.addEventListener('click', () => auth.logout());
    }

    function applyStudentData(data) {
        state.kind = 'student';
        applyStudentSession(data);
        el('studentSignOutBtn')?.classList.remove('hidden');
    }

    async function loadSession() {
        try {
            return await api('/api/auth/me');
        } catch (error) {
            return null;
        }
    }

    auth.ready = loadSession().then(data => {
        if (!data && window.PAGE_ROLE === 'proctor') {
            const next = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.replace(`/login.html?next=${next}`);
            return null;
        }

        onReady(() => {
            if (window.PAGE_ROLE === 'student') {
                bindStudentPortal();
                if (data && data.kind === 'student') applyStudentData(data);
                return;
            }
            if (data && data.kind === 'staff' && window.PAGE_ROLE === 'proctor') {
                applyStaffSession(data);
            }
        });

        return data;
    });
})();
