// Question bank, exam setup, and student exam paper
(function () {
    'use strict';

    const TYPE_LABELS = {
        single: 'Single choice',
        multiple: 'Multiple choice',
        truefalse: 'True / false',
        short: 'Essay'
    };

    const QUESTION_TYPES = ['multiple', 'truefalse', 'short'];

    const state = {
        pageRole: window.PAGE_ROLE || null,
        session: { roomId: null, userType: null },
        questions: [],
        subjects: [],
        exams: [],
        draft: null,
        deliveredExam: null,
        studentExam: null,
        studentSubmitted: false,
        localAnswers: {},
        saveTimers: new Map(),
        studentTimer: null,
        autoSubmitted: false,
        editingQuestionId: null,
        questionDrafts: [],
        questionSubjectId: '',
        bankLoading: false,
        examsLoading: false,
        lastRoomId: null
    };

    const el = id => document.getElementById(id);

    function can(permission) {
        return !!(window.verotAuth && window.verotAuth.can(permission));
    }

    function canAny(permissions) {
        return permissions.some(permission => can(permission));
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeAttr(value) {
        return escapeHtml(value);
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

    function typeLabel(type) {
        return TYPE_LABELS[type] || type;
    }

    function marksLabel(marks) {
        return `${marks} mark${marks === 1 ? '' : 's'}`;
    }

    function formatTime(timestamp) {
        if (!timestamp) return '-';
        return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function formatDuration(ms) {
        const total = Math.max(0, Math.floor(ms / 1000));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const seconds = total % 60;
        const pad = value => String(value).padStart(2, '0');
        return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
    }

    // ==================== QUESTION BANK ====================

    async function loadBank() {
        if (state.bankLoading) return;
        state.bankLoading = true;
        el('bankList').innerHTML = '<p class="loading-line">Loading questions…</p>';
        try {
            const data = await api('/api/questions');
            state.questions = data.questions || [];
            state.subjects = data.subjects || [];
            renderSubjectOptions();
            renderBank();
        } catch (error) {
            el('bankList').innerHTML = '<p class="loading-line">Could not load the question bank.</p>';
            toast(`❌ ${error.message}`, 'error');
        } finally {
            state.bankLoading = false;
        }
    }

    function ensureBankLoaded() {
        if (!state.questions.length && !state.bankLoading) loadBank();
    }

    function renderSubjectOptions() {
        const selected = el('bankSubjectFilter').value;
        el('bankSubjectFilter').innerHTML = '<option value="">All subjects</option>'
            + state.subjects.map(subject => {
                const label = subject.code ? `${subject.code} - ${subject.name}` : subject.name;
                return `<option value="${escapeAttr(subject.name)}"${subject.name === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
            }).join('');

        if (el('subjectOptions')) {
            el('subjectOptions').innerHTML = state.subjects
                .map(subject => `<option value="${escapeAttr(subject.name)}"></option>`)
                .join('');
        }

        renderQuestionSubject();
    }

    function filteredQuestions() {
        const search = el('bankSearch').value.trim().toLowerCase();
        const subject = el('bankSubjectFilter').value;
        const type = el('bankTypeFilter').value;

        return state.questions.filter(question => {
            if (subject && question.subject !== subject) return false;
            if (type && question.type !== type) return false;
            if (search) {
                const haystack = `${question.prompt} ${question.subject} ${question.topic} ${question.options.join(' ')}`.toLowerCase();
                if (!haystack.includes(search)) return false;
            }
            return true;
        });
    }

    function questionOptionsMarkup(question) {
        if (question.type === 'short') {
            return '<p class="q-manual"><i class="fas fa-pen"></i> Marked manually by the invigilator.</p>';
        }
        return `<ol class="q-options">${question.options.map((option, index) => {
            const correct = question.correct.includes(index);
            return `<li class="${correct ? 'correct' : ''}">
                ${correct ? '<i class="fas fa-circle-check"></i>' : '<i class="far fa-circle"></i>'}
                <span>${escapeHtml(option)}</span>
            </li>`;
        }).join('')}</ol>`;
    }

    function renderBank() {
        const questions = filteredQuestions();
        el('bankCount').textContent = state.questions.length;
        el('bankResultCount').textContent = `${questions.length} question${questions.length === 1 ? '' : 's'}`;

        if (!questions.length) {
            el('bankList').innerHTML = '';
            el('bankEmpty').classList.remove('hidden');
            el('bankEmpty').querySelector('h3').textContent = state.questions.length ? 'No matching questions' : 'No questions yet';
            el('bankEmpty').querySelector('p').textContent = state.questions.length
                ? 'Adjust the filters or search for something else.'
                : 'Add your first question to start building the bank.';
            return;
        }

        el('bankEmpty').classList.add('hidden');
        el('bankList').innerHTML = questions.map(question => `
            <article class="question-card">
                <div class="question-card-head">
                    <span class="q-type-chip">${typeLabel(question.type)}</span>
                    <span class="q-meta">
                        ${escapeHtml(question.subject)} &middot; ${marksLabel(question.marks)}
                    </span>
                    <div class="q-actions">
                        <button type="button" class="icon-btn" data-action="edit-question" data-id="${escapeAttr(question.id)}" title="Edit question">
                            <i class="fas fa-pen"></i>
                        </button>
                        <button type="button" class="icon-btn icon-danger" data-action="delete-question" data-id="${escapeAttr(question.id)}" title="Delete question">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
                <p class="q-prompt">${escapeHtml(question.prompt)}</p>
                ${questionOptionsMarkup(question)}
            </article>
        `).join('');
    }

    // A question being written in the editor; several can be saved in one pass against one subject
    function emptyDraft(type = 'multiple') {
        const draft = {
            type: QUESTION_TYPES.includes(type) ? type : 'multiple',
            marks: 1,
            prompt: '',
            options: ['', '', '', ''],
            correct: []
        };
        if (draft.type === 'short') {
            draft.options = [];
            draft.correct = [];
        } else if (draft.type === 'truefalse') {
            draft.options = ['True', 'False'];
        }
        return draft;
    }

    function draftFromQuestion(question) {
        return {
            type: QUESTION_TYPES.includes(question.type) ? question.type : 'multiple',
            marks: question.marks || 1,
            prompt: question.prompt || '',
            options: (question.options || []).slice(0, 8),
            correct: (question.correct || []).slice()
        };
    }

    function subjectLabel(subject) {
        return subject.code ? `${subject.code} - ${subject.name}` : subject.name;
    }

    // The subject is chosen once for the whole batch of questions
    function renderQuestionSubject() {
        const select = el('questionSubject');
        if (!select || state.editingQuestionId) return;
        const options = state.subjects.length
            ? ['<option value="">Select a subject</option>'].concat(state.subjects.map(subject =>
                `<option value="${escapeAttr(subject.id)}"${subject.id === state.questionSubjectId ? ' selected' : ''}>${escapeHtml(subjectLabel(subject))}</option>`
            )).join('')
            : '<option value="">No subjects yet - add one in the Subjects tab</option>';
        select.innerHTML = options;
        select.value = state.questionSubjectId;
    }

    function typeHint(type) {
        if (type === 'short') return 'Students type a free-text answer. The invigilator marks it manually.';
        if (type === 'truefalse') return 'Tick whether the statement is true or false.';
        return 'Tick all correct answers.';
    }

    function draftCardMarkup(draft, index) {
        const editing = !!state.editingQuestionId;
        const isShort = draft.type === 'short';
        const isTrueFalse = draft.type === 'truefalse';
        const inputType = draft.type === 'multiple' ? 'checkbox' : 'radio';
        const options = isTrueFalse ? ['True', 'False'] : draft.options.slice(0, 8);
        const canAddOption = !isShort && !isTrueFalse && options.length < 8;

        const marksControl = `
            <div class="draft-marks">
                <span>Marks</span>
                <button type="button" class="mark-step" data-action="marks-down" title="Reduce marks" aria-label="Reduce marks"><i class="fas fa-minus"></i></button>
                <input type="number" min="1" max="20" step="1" inputmode="numeric" data-field="marks" value="${draft.marks}" aria-label="Marks for question ${index + 1}">
                <button type="button" class="mark-step" data-action="marks-up" title="Increase marks" aria-label="Increase marks"><i class="fas fa-plus"></i></button>
            </div>`;

        const optionRows = isShort ? '' : options.map((value, optionIndex) => `
            <div class="option-row" data-option-index="${optionIndex}">
                <input type="${inputType}" name="correct-${index}" data-correct="${optionIndex}" ${draft.correct.includes(optionIndex) ? 'checked' : ''} aria-label="Correct answer">
                <input type="text" class="option-input" value="${escapeAttr(value)}" placeholder="Option ${optionIndex + 1}" data-option="${optionIndex}" ${isTrueFalse ? 'readonly' : ''}>
                ${isTrueFalse ? '' : '<button type="button" class="icon-btn" data-action="remove-option" title="Remove option"><i class="fas fa-xmark"></i></button>'}
            </div>`).join('');

        return `
            <article class="draft-card" data-draft-index="${index}" data-draft-type="${draft.type}">
                <div class="draft-head">
                    <h3><span class="draft-number">Q${index + 1}</span> ${typeLabel(draft.type)}</h3>
                    <div class="draft-head-actions">
                        ${marksControl}
                        ${editing ? '' : '<button type="button" class="btn btn-danger btn-small" data-action="remove-draft" title="Delete this question"><i class="fas fa-trash"></i> Delete</button>'}
                    </div>
                </div>
                <div class="form-group">
                    <label>Question <span class="required-star">*</span></label>
                    <textarea rows="3" maxlength="2000" data-field="prompt" placeholder="Write the question prompt">${escapeHtml(draft.prompt)}</textarea>
                </div>
                <div class="form-group draft-options${isShort ? ' hidden' : ''}">
                    <label>Answer options</label>
                    <div class="option-editor">${optionRows}</div>
                    <button type="button" class="btn btn-secondary btn-small${canAddOption ? '' : ' hidden'}" data-action="add-option">
                        <i class="fas fa-plus"></i> Add option
                    </button>
                    <p class="form-hint">${typeHint(draft.type)}</p>
                </div>
                <p class="form-hint${isShort ? '' : ' hidden'}">${typeHint('short')}</p>
            </article>`;
    }

    function renderDraftList() {
        const container = el('questionDrafts');
        if (!container) return;
        renderQuestionSubject();
        container.innerHTML = state.questionDrafts.length
            ? state.questionDrafts.map((draft, index) => draftCardMarkup(draft, index)).join('')
            : '<p class="draft-empty">No questions yet. Use the buttons below to add one.</p>';
        const addRow = el('draftAddRow');
        if (addRow) addRow.classList.toggle('hidden', !!state.editingQuestionId);
        updateDraftSaveLabel();
    }

    function updateDraftSaveLabel() {
        const btn = el('questionSaveBtn');
        if (!btn) return;
        const count = state.questionDrafts.length;
        btn.disabled = !state.editingQuestionId && count === 0;
        btn.innerHTML = state.editingQuestionId
            ? '<i class="fas fa-floppy-disk"></i> Save question'
            : `<i class="fas fa-floppy-disk"></i> Save ${count} question${count === 1 ? '' : 's'}`;
    }

    function draftCardElement(index) {
        const container = el('questionDrafts');
        return container ? container.querySelector(`[data-draft-index="${index}"]`) : null;
    }

    function syncDraftFromCard(index) {
        const draft = state.questionDrafts[index];
        const card = draftCardElement(index);
        if (!draft || !card) return draft;

        const marksField = card.querySelector('[data-field="marks"]');
        const promptField = card.querySelector('[data-field="prompt"]');
        if (marksField) draft.marks = clampMarks(marksField.value);
        if (promptField) draft.prompt = promptField.value;

        if (draft.type === 'short') return draft;

        const rows = [...card.querySelectorAll('.option-row')];
        draft.options = rows.map(row => row.querySelector('.option-input').value);
        draft.correct = rows
            .map((row, optionIndex) => (row.querySelector('input[data-correct]').checked ? optionIndex : -1))
            .filter(optionIndex => optionIndex >= 0);
        return draft;
    }

    function syncAllDrafts() {
        state.questionDrafts.forEach((draft, index) => syncDraftFromCard(index));
    }

    function clampMarks(value) {
        return Math.min(20, Math.max(1, Number(value) || 1));
    }

    function setDraftMarks(index, marks) {
        syncAllDrafts();
        const draft = state.questionDrafts[index];
        if (!draft) return;
        draft.marks = clampMarks(marks);
        const input = draftCardElement(index)?.querySelector('[data-field="marks"]');
        if (input) input.value = draft.marks;
    }

    function renderDraftCard(index) {
        const card = draftCardElement(index);
        const draft = state.questionDrafts[index];
        if (!card || !draft) return;
        const wrapper = document.createElement('div');
        wrapper.innerHTML = draftCardMarkup(draft, index);
        const replacement = wrapper.firstElementChild;
        if (replacement) card.replaceWith(replacement);
    }

    function openQuestionEditor(question = null) {
        if (!can('questions')) {
            toast('Your access role cannot edit questions', 'error');
            return;
        }
        state.editingQuestionId = question ? question.id : null;
        el('questionModalTitle').innerHTML = question
            ? '<i class="fas fa-pen"></i> Edit question'
            : '<i class="fas fa-plus"></i> New questions';

        if (question) {
            state.questionSubjectId = question.subjectId || '';
            state.questionDrafts = [draftFromQuestion(question)];
        } else {
            state.questionSubjectId = state.subjects.length === 1 ? state.subjects[0].id : '';
            state.questionDrafts = [emptyDraft('multiple')];
        }

        renderDraftList();
        el('questionModal').classList.remove('hidden');
        const target = state.questionSubjectId
            ? el('questionDrafts').querySelector('[data-field="prompt"]')
            : el('questionSubject');
        if (target) target.focus();
    }

    function closeQuestionEditor() {
        el('questionModal').classList.add('hidden');
        state.editingQuestionId = null;
        state.questionDrafts = [];
        state.questionSubjectId = '';
    }

    function addDraft(type) {
        syncAllDrafts();
        state.questionDrafts.push(emptyDraft(type));
        renderDraftList();

        const cards = el('questionDrafts').querySelectorAll('.draft-card');
        const card = cards[cards.length - 1];
        if (card) {
            card.scrollIntoView({ block: 'nearest' });
            const prompt = card.querySelector('[data-field="prompt"]');
            if (prompt) prompt.focus();
        }
    }

    function removeDraft(index) {
        syncAllDrafts();
        state.questionDrafts.splice(index, 1);
        renderDraftList();
    }

    function addDraftOption(index) {
        syncAllDrafts();
        const draft = state.questionDrafts[index];
        if (!draft || draft.type === 'short' || draft.type === 'truefalse') return;
        if (draft.options.length >= 8) {
            toast('A question can have at most 8 options', 'error');
            return;
        }
        draft.options.push('');
        renderDraftCard(index);
    }

    function removeDraftOption(index, optionIndex) {
        syncAllDrafts();
        const draft = state.questionDrafts[index];
        if (!draft || draft.type === 'short' || draft.type === 'truefalse') return;
        if (draft.options.length <= 2) {
            toast('Keep at least two options', 'error');
            return;
        }
        draft.options.splice(optionIndex, 1);
        draft.correct = draft.correct
            .filter(value => value !== optionIndex)
            .map(value => (value > optionIndex ? value - 1 : value));
        renderDraftCard(index);
    }



    function draftPayload(draft, index) {
        const label = `Question ${index + 1}`;
        if (!state.questionSubjectId) throw new Error('Select a subject for these questions');

        const prompt = String(draft.prompt || '').trim();
        if (!prompt) throw new Error(`${label}: add the question text`);

        const payload = {
            subjectId: state.questionSubjectId,
            type: draft.type,
            prompt,
            marks: clampMarks(draft.marks),
            options: [],
            correct: []
        };

        if (draft.type === 'short') return payload;

        if (draft.type === 'truefalse') {
            if (!draft.correct.length) throw new Error(`${label}: select the correct answer`);
            payload.options = ['True', 'False'];
            payload.correct = [draft.correct[0]];
            return payload;
        }

        const options = draft.options.map(option => String(option || '').trim());
        if (options.filter(Boolean).length < 2) throw new Error(`${label}: add at least two answer options`);
        if (options.some(option => !option)) throw new Error(`${label}: fill in every option or remove the empty one`);
        if (!draft.correct.length) throw new Error(`${label}: select the correct answer`);

        payload.options = options;
        payload.correct = draft.correct.slice().sort((a, b) => a - b);
        return payload;
    }

    async function saveQuestion(event) {
        event.preventDefault();
        if (!can('questions')) {
            toast('Your access role cannot edit questions', 'error');
            return;
        }

        syncAllDrafts();
        if (!state.editingQuestionId && !state.questionDrafts.length) {
            toast('Add at least one question first', 'error');
            return;
        }
        const submitBtn = el('questionSaveBtn');
        if (submitBtn) submitBtn.disabled = true;

        try {
            if (state.editingQuestionId) {
                const payload = draftPayload(state.questionDrafts[0], 0);
                await api(`/api/questions/${encodeURIComponent(state.editingQuestionId)}`, {
                    method: 'PUT',
                    body: JSON.stringify(payload)
                });
                toast('✅ Question updated', 'success');
                closeQuestionEditor();
                await loadBank();
                if (state.draft) renderQuestionPicker();
                return;
            }

            const payloads = state.questionDrafts.map((draft, index) => draftPayload(draft, index));
            const data = await api('/api/questions/batch', {
                method: 'POST',
                body: JSON.stringify({ questions: payloads })
            });
            const summary = data.summary || {};

            // Keep the questions the server rejected so they can be corrected
            if (summary.skipped) {
                const failed = new Set((summary.errors || []).map(error => error.index));
                const firstError = (summary.errors || [])[0];
                state.questionDrafts = state.questionDrafts.filter((draft, index) => failed.has(index));
                renderDraftList();
                await loadBank();
                toast(
                    `⚠️ ${summary.created || 0} saved, ${summary.skipped} needs attention` +
                    (firstError ? ` — question ${firstError.index + 1}: ${firstError.message}` : ''),
                    'error'
                );
                return;
            }

            toast(
                `✅ ${summary.created || payloads.length} question${payloads.length === 1 ? '' : 's'} added to the bank`,
                'success'
            );
            closeQuestionEditor();
            await loadBank();
            if (state.draft) renderQuestionPicker();
        } catch (error) {
            toast(`❌ ${error.message}`, 'error');
        } finally {
            updateDraftSaveLabel();
        }
    }

    async function deleteQuestion(id) {
        if (!can('questions')) {
            toast('Your access role cannot edit questions', 'error');
            return;
        }
        if (!window.confirm('Delete this question? It will also be removed from any paper using it.')) return;
        try {
            await api(`/api/questions/${encodeURIComponent(id)}`, { method: 'DELETE' });
            toast('Question deleted', 'success');
            await loadBank();
            if (state.draft) {
                state.draft.questions = state.draft.questions.filter(item => item.questionId !== id);
                renderQuestionPicker();
                updateExamTotals();
            }
        } catch (error) {
            toast(`❌ ${error.message}`, 'error');
        }
    }

    // ==================== EXAM SETUP ====================

    async function loadExams() {
        if (state.examsLoading) return;
        state.examsLoading = true;
        try {
            const data = await api('/api/exams');
            state.exams = data.exams || [];
            renderExamList();
        } catch (error) {
            el('examList').innerHTML = '<p class="loading-line">Could not load papers.</p>';
            toast(`❌ ${error.message}`, 'error');
        } finally {
            state.examsLoading = false;
        }
    }

    function renderExamList() {
        el('examCount').textContent = state.exams.length;
        el('examListEmpty').classList.toggle('hidden', state.exams.length > 0);

        el('examList').innerHTML = state.exams.map(exam => `
            <button type="button" class="exam-list-item ${state.draft && state.draft.id === exam.id ? 'active' : ''}" data-exam-id="${escapeAttr(exam.id)}">
                <span class="exam-list-title">${escapeHtml(exam.title)}</span>
                <span class="exam-list-meta">
                    ${exam.subject ? `${escapeHtml(exam.subject)} &middot; ` : ''}
                    ${exam.questionCount} question${exam.questionCount === 1 ? '' : 's'} &middot; ${exam.totalMarks} marks
                </span>
            </button>
        `).join('');
    }

    async function selectExam(id) {
        try {
            const data = await api(`/api/exams/${encodeURIComponent(id)}`);
            const exam = data.exam;
            state.draft = {
                id: exam.id,
                title: exam.title,
                description: exam.description || '',
                subject: exam.subject || '',
                durationMinutes: exam.durationMinutes,
                questions: (exam.questions || []).map(item => ({ ...item }))
            };
            el('examEditorEmpty').classList.add('hidden');
            el('examEditorBody').classList.remove('hidden');
            el('examTitle').value = state.draft.title;
            el('examSubject').value = state.draft.subject;
            el('examDuration').value = state.draft.durationMinutes;
            el('examDescription').value = state.draft.description;
            el('examQuestionSearch').value = '';
            renderExamList();
            renderQuestionPicker();
            updateExamTotals();
            updateDeliveryUI();
        } catch (error) {
            toast(`❌ ${error.message}`, 'error');
            loadExams();
        }
    }

    function clearExamEditor() {
        state.draft = null;
        el('examEditorBody').classList.add('hidden');
        el('examEditorEmpty').classList.remove('hidden');
        renderExamList();
    }

    function examBankQuestions() {
        const search = el('examQuestionSearch').value.trim().toLowerCase();
        return state.questions.filter(question => {
            if (!search) return true;
            const haystack = `${question.prompt} ${question.subject} ${question.topic}`.toLowerCase();
            return haystack.includes(search);
        });
    }

    function renderQuestionPicker() {
        if (!state.draft) return;
        const container = el('examQuestionPicker');
        const questions = examBankQuestions();

        if (!questions.length) {
            container.innerHTML = '<p class="loading-line">No questions match. Add questions in the bank first.</p>';
            return;
        }

        container.innerHTML = questions.map(question => {
            const selected = state.draft.questions.find(item => item.questionId === question.id);
            return `
                <label class="picker-row ${selected ? 'selected' : ''}">
                    <input type="checkbox" data-pick-question="${escapeAttr(question.id)}" ${selected ? 'checked' : ''}>
                    <span class="picker-body">
                        <span class="picker-prompt">${escapeHtml(question.prompt)}</span>
                        <span class="picker-meta">${escapeHtml(question.subject)} &middot; ${typeLabel(question.type)} &middot; ${marksLabel(question.marks)}</span>
                    </span>
                    <span class="picker-marks-wrap" title="Marks in this paper">
                        <input type="number" min="1" max="20" value="${selected ? selected.marks : question.marks}" data-pick-marks="${escapeAttr(question.id)}" ${selected ? '' : 'disabled'}>
                    </span>
                </label>
            `;
        }).join('');
    }

    function setQuestionPicked(questionId, checked) {
        if (!state.draft) return;
        if (checked) {
            if (state.draft.questions.some(item => item.questionId === questionId)) return;
            const question = state.questions.find(item => item.id === questionId);
            state.draft.questions.push({ questionId, marks: question ? question.marks : 1 });
        } else {
            state.draft.questions = state.draft.questions.filter(item => item.questionId !== questionId);
        }
        renderQuestionPicker();
        updateExamTotals();
        updateDeliveryUI();
    }

    function setQuestionMarks(questionId, marks) {
        if (!state.draft) return;
        const entry = state.draft.questions.find(item => item.questionId === questionId);
        if (!entry) return;
        entry.marks = Math.min(20, Math.max(1, Number(marks) || 1));
        updateExamTotals();
        updateDeliveryUI();
    }

    function updateExamTotals() {
        if (!state.draft) return;
        const marks = state.draft.questions.reduce((sum, item) => sum + (item.marks || 1), 0);
        el('examSelectedCount').textContent = state.draft.questions.length;
        el('examMarksDisplay').value = marks;
    }

    function examPayloadFromEditor() {
        return {
            title: el('examTitle').value.trim(),
            subject: el('examSubject').value.trim(),
            durationMinutes: Number(el('examDuration').value) || 60,
            description: el('examDescription').value.trim(),
            questions: state.draft.questions.map(item => ({ questionId: item.questionId, marks: item.marks }))
        };
    }

    async function saveExam() {
        if (!state.draft) return;
        if (!can('quizzes')) {
            toast('Your access role cannot edit quizzes', 'error');
            return;
        }
        const payload = examPayloadFromEditor();
        if (!payload.title) {
            toast('❌ Add a paper title first', 'error');
            el('examTitle').focus();
            return;
        }
        el('saveExamBtn').disabled = true;
        try {
            const data = await api(`/api/exams/${encodeURIComponent(state.draft.id)}`, {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
            state.draft = {
                id: data.exam.id,
                title: data.exam.title,
                description: data.exam.description,
                subject: data.exam.subject,
                durationMinutes: data.exam.durationMinutes,
                questions: data.exam.questions.map(item => ({ ...item }))
            };
            toast('✅ Paper saved', 'success');
            await loadExams();
        } catch (error) {
            toast(`❌ ${error.message}`, 'error');
        } finally {
            el('saveExamBtn').disabled = false;
        }
    }

    async function deleteExam() {
        if (!state.draft) return;
        if (!can('quizzes')) {
            toast('Your access role cannot edit quizzes', 'error');
            return;
        }
        if (!window.confirm(`Delete "${state.draft.title}"? This cannot be undone.`)) return;
        try {
            await api(`/api/exams/${encodeURIComponent(state.draft.id)}`, { method: 'DELETE' });
            toast('Paper deleted', 'success');
            if (state.deliveredExam && state.deliveredExam.id === state.draft.id) state.deliveredExam = null;
            clearExamEditor();
            updateExamChip();
            await loadExams();
        } catch (error) {
            toast(`❌ ${error.message}`, 'error');
        }
    }

    function openExamModal() {
        if (!can('quizzes')) {
            toast('Your access role cannot create quizzes', 'error');
            return;
        }
        el('newExamTitle').value = '';
        el('newExamSubject').value = el('bankSubjectFilter').value || '';
        el('newExamDuration').value = 60;
        el('newExamDescription').value = '';
        el('examModal').classList.remove('hidden');
        el('newExamTitle').focus();
    }

    function closeExamModal() {
        el('examModal').classList.add('hidden');
    }

    async function createExam(event) {
        event.preventDefault();
        if (!can('quizzes')) {
            toast('Your access role cannot create quizzes', 'error');
            return;
        }
        const title = el('newExamTitle').value.trim();
        if (!title) {
            toast('❌ Paper title is required', 'error');
            return;
        }
        try {
            const data = await api('/api/exams', {
                method: 'POST',
                body: JSON.stringify({
                    title,
                    subject: el('newExamSubject').value.trim(),
                    durationMinutes: Number(el('newExamDuration').value) || 60,
                    description: el('newExamDescription').value.trim(),
                    questions: []
                })
            });
            closeExamModal();
            toast('✅ Paper created', 'success');
            await loadExams();
            switchWorkspace('exams');
            selectExam(data.exam.id);
        } catch (error) {
            toast(`❌ ${error.message}`, 'error');
        }
    }

    // ==================== DELIVERY ====================

    function currentSessionRoom() {
        const app = window.proctoringApp;
        return state.session.roomId || (app && app.roomId) || null;
    }

    function updateExamChip() {
        const chip = el('examLiveChip');
        if (!chip) return;
        const exam = state.deliveredExam;
        if (exam && exam.status === 'live') {
            chip.classList.remove('hidden');
            el('examLiveTitle').textContent = `${exam.title} · ${exam.submittedCount}/${exam.candidateCount || 0} submitted`;
        } else {
            chip.classList.add('hidden');
        }
    }

    function updateDeliveryUI() {
        if (state.pageRole !== 'proctor') return;
        const roomId = currentSessionRoom();
        const exam = state.deliveredExam;
        const sessionText = el('deliverySessionText');
        const deliverBtn = el('deliverExamBtn');
        const endBtn = el('endExamBtn');
        const statusEl = el('deliveryStatus');

        if (!roomId) {
            sessionText.textContent = 'Create or join a session first, then deliver this paper to it.';
        } else {
            sessionText.textContent = `Current session: ${roomId}. Students in this session receive the paper instantly.`;
        }

        const isLive = !!exam && exam.status === 'live';
        const isEnded = !!exam && exam.status === 'ended';
        const sameExam = !!(state.draft && exam && exam.id === state.draft.id);
        const hasQuestions = !!(state.draft && state.draft.questions.length);

        statusEl.textContent = isLive ? 'Live now' : isEnded ? 'Ended' : 'Not delivered';
        statusEl.className = 'delivery-status' + (isLive ? ' live' : isEnded ? ' ended' : '');

        deliverBtn.disabled = !roomId || !hasQuestions || isLive;
        deliverBtn.classList.toggle('hidden', isLive);
        endBtn.classList.toggle('hidden', !isLive);

        if (isLive && sameExam) {
            sessionText.textContent = `${exam.title} is live in session ${roomId}. ${exam.submittedCount}/${exam.candidateCount || 0} students submitted.`;
        }

        renderResults();
    }

    function renderResults() {
        const exam = state.deliveredExam;
        const results = el('examResults');
        if (!exam || !(exam.status === 'live' || exam.status === 'ended')) {
            results.classList.add('hidden');
            return;
        }
        results.classList.remove('hidden');

        const answered = exam.answeredCount || 0;
        const submitted = exam.submittedCount || 0;
        const candidates = exam.candidateCount || 0;
        el('resultStats').innerHTML = `
            <span class="result-stat"><strong>${candidates}</strong> students</span>
            <span class="result-stat"><strong>${answered}</strong> started</span>
            <span class="result-stat"><strong>${submitted}</strong> submitted</span>
            <span class="result-stat ${exam.status === 'live' ? 'live' : ''}">${exam.status === 'live' ? 'Live' : 'Ended'}</span>
        `;

        const submissions = exam.submissions || [];
        if (!submissions.length) {
            el('resultRows').innerHTML = '<tr><td colspan="6" class="table-empty">No submissions yet.</td></tr>';
            return;
        }

        el('resultRows').innerHTML = submissions.map((submission, index) => {
            const score = submission.autoScore == null ? '-' : `${submission.autoScore}/${submission.autoPossible}`;
            const review = submission.needsReview ? `${submission.needsReview} to mark` : 'None';
            return `<tr>
                <td>${escapeHtml(submission.name)}</td>
                <td><span class="status-pill submitted">Submitted</span></td>
                <td>${score}</td>
                <td>${review}</td>
                <td>${formatTime(submission.submittedAt)}</td>
                <td><button type="button" class="link-btn" data-review-index="${index}">View</button></td>
            </tr>
            <tr class="result-detail hidden" data-detail-index="${index}">
                <td colspan="6">${answerReviewMarkup(submission)}</td>
            </tr>`;
        }).join('');
    }

    function answerReviewMarkup(submission) {
        const exam = state.deliveredExam;
        const questions = exam && exam.questions ? exam.questions : [];
        if (!questions.length) {
            return '<p class="table-empty">Question details are unavailable for this submission.</p>';
        }

        return `<div class="answer-review">${questions.map((question, index) => {
            const answer = submission.answers ? submission.answers[question.id] : null;
            let given = 'No answer';
            let correct = '';
            let verdict = '';

            if (question.type === 'short') {
                given = typeof answer === 'string' && answer ? answer : 'No answer';
                verdict = '<span class="review-tag pending">Mark manually</span>';
            } else {
                const selected = question.type === 'multiple'
                    ? (Array.isArray(answer) ? answer : [])
                    : (answer === null || answer === undefined ? [] : [Number(answer)]);
                given = selected.length
                    ? selected.map(optionIndex => question.options[optionIndex]).filter(Boolean).join(', ') || 'No answer'
                    : 'No answer';
                correct = question.correct.map(optionIndex => question.options[optionIndex]).filter(Boolean).join(', ');
                const isCorrect = selected.length === question.correct.length
                    && question.correct.every(optionIndex => selected.includes(optionIndex));
                verdict = `<span class="review-tag ${isCorrect ? 'correct' : 'wrong'}">${isCorrect ? 'Correct' : 'Incorrect'}</span>`;
            }

            return `<div class="answer-review-item">
                <p class="review-prompt"><strong>Q${index + 1}.</strong> ${escapeHtml(question.prompt)} ${verdict}</p>
                <p class="review-given"><span>Given:</span> ${escapeHtml(given)}</p>
                ${correct ? `<p class="review-correct"><span>Correct:</span> ${escapeHtml(correct)}</p>` : ''}
            </div>`;
        }).join('')}</div>`;
    }

    async function deliverExam() {
        if (!state.draft) return;
        if (!can('invigilation')) {
            toast('Your access role cannot run invigilation', 'error');
            return;
        }
        const roomId = currentSessionRoom();
        if (!roomId) {
            toast('Create or join a session before delivering', 'error');
            return;
        }
        if (!state.draft.questions.length) {
            toast('Add at least one question before delivering', 'error');
            return;
        }

        el('deliverExamBtn').disabled = true;
        try {
            const data = await api(`/api/rooms/${encodeURIComponent(roomId)}/exam`, {
                method: 'POST',
                body: JSON.stringify({ examId: state.draft.id })
            });
            state.deliveredExam = data.exam;
            toast('✅ Exam delivered to the session', 'success');
            updateExamChip();
            updateDeliveryUI();
        } catch (error) {
            toast(`❌ ${error.message}`, 'error');
        } finally {
            el('deliverExamBtn').disabled = false;
            updateDeliveryUI();
        }
    }

    async function endExam() {
        if (!can('invigilation')) {
            toast('Your access role cannot run invigilation', 'error');
            return;
        }
        const roomId = currentSessionRoom();
        if (!roomId || !state.deliveredExam) return;
        if (!window.confirm('End the exam for everyone? Students will no longer be able to submit.')) return;

        try {
            const data = await api(`/api/rooms/${encodeURIComponent(roomId)}/exam/end`, {
                method: 'POST'
            });
            state.deliveredExam = data.exam;
            toast('Exam ended', 'success');
            updateExamChip();
            updateDeliveryUI();
        } catch (error) {
            toast(`❌ ${error.message}`, 'error');
        }
    }

    async function restoreRoomExam(roomId) {
        const app = window.proctoringApp;
        if (!app || !roomId) return;
        const isProctor = state.pageRole === 'proctor';
        try {
            const data = await api(`/api/rooms/${encodeURIComponent(roomId)}/exam`);
            if (state.session.roomId !== roomId) return;
            if (isProctor) {
                state.deliveredExam = data.exam || null;
                updateExamChip();
                updateDeliveryUI();
            } else if (!state.studentExam) {
                setExamFromServer(data.exam);
            }
        } catch (error) {
            console.warn('Could not restore exam state:', error.message);
        }
    }

    // ==================== STUDENT PAPER ====================

    function setExamFromServer(exam) {
        if (state.pageRole === 'proctor') {
            state.deliveredExam = exam || null;
            updateExamChip();
            updateDeliveryUI();
            if (exam && !state.draft) selectExam(exam.id);
            return;
        }

        const examChanged = !state.studentExam || (exam && state.studentExam.id !== exam.id);
        state.studentExam = exam || null;

        if (!exam) {
            clearInterval(state.studentTimer);
            el('studentExamPaper').classList.add('hidden');
            el('studentExamComplete').classList.add('hidden');
            el('studentExamEmpty').classList.remove('hidden');
            el('studentExamBadge').classList.add('hidden');
            return;
        }

        if (examChanged) {
            state.localAnswers = {};
            state.autoSubmitted = false;
            state.studentSubmitted = !!exam.mySubmission;
            el('studentExamBadge').classList.remove('hidden');
        }
        if (exam.mySubmission) state.studentSubmitted = true;

        renderStudentExam();
        startStudentTimer();

        if (examChanged && exam.status === 'live' && !state.studentSubmitted) {
            switchWorkspace('exams');
        }
    }

    function renderStudentExam() {
        const exam = state.studentExam;
        if (!exam) return;

        el('studentExamEmpty').classList.add('hidden');
        el('studentExamPaper').classList.remove('hidden');

        el('studentExamSubject').textContent = exam.subject || 'Exam paper';
        el('studentExamTitle').textContent = exam.title;
        el('studentExamDescription').textContent = exam.description || 'Answer all questions, then submit before the timer ends.';
        el('studentExamMarks').textContent = exam.totalMarks;
        el('studentExamCount').textContent = exam.questionCount;

        const statusEl = el('studentExamStatus');
        statusEl.textContent = exam.status === 'ended' ? 'Ended' : 'Live';
        statusEl.className = 'paper-status ' + (exam.status === 'ended' ? 'ended' : 'live');

        if (state.studentSubmitted) {
            renderStudentComplete();
        } else {
            el('studentExamComplete').classList.add('hidden');
            el('studentExamPaper').classList.remove('hidden');
        }

        renderStudentQuestions();
    }

    function renderStudentQuestions() {
        const exam = state.studentExam;
        const container = el('studentExamQuestions');
        const locked = exam.status === 'ended' || state.studentSubmitted;

        container.innerHTML = exam.questions.map((question, index) => {
            const answer = state.localAnswers[question.id] !== undefined
                ? state.localAnswers[question.id]
                : exam.myAnswers ? exam.myAnswers[question.id] : undefined;

            let inputMarkup = '';
            if (question.type === 'short') {
                inputMarkup = `<textarea class="paper-textarea" name="answer-${escapeAttr(question.id)}" rows="3" placeholder="Type your answer" ${locked ? 'disabled' : ''}>${escapeHtml(typeof answer === 'string' ? answer : '')}</textarea>`;
            } else {
                const inputType = question.type === 'multiple' ? 'checkbox' : 'radio';
                inputMarkup = `<div class="paper-options">${question.options.map((option, optionIndex) => {
                    const checked = question.type === 'multiple'
                        ? Array.isArray(answer) && answer.includes(optionIndex)
                        : Number(answer) === optionIndex;
                    return `<label class="paper-option ${checked ? 'checked' : ''}">
                        <input type="${inputType}" name="answer-${escapeAttr(question.id)}" value="${optionIndex}" ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''}>
                        <span class="paper-option-letter">${String.fromCharCode(65 + optionIndex)}</span>
                        <span>${escapeHtml(option)}</span>
                    </label>`;
                }).join('')}</div>`;
            }

            return `<article class="paper-question" data-question-id="${escapeAttr(question.id)}">
                <div class="pq-head">
                    <span class="pq-number">Q${index + 1}</span>
                    <span class="q-type-chip">${typeLabel(question.type)}</span>
                    <span class="pq-marks">${marksLabel(question.marks)}</span>
                </div>
                <p class="pq-prompt">${escapeHtml(question.prompt)}</p>
                ${inputMarkup}
            </article>`;
        }).join('');

        const submitBtn = el('studentSubmitBtn');
        submitBtn.disabled = locked;
        submitBtn.innerHTML = state.studentSubmitted
            ? '<i class="fas fa-check"></i> Submitted'
            : '<i class="fas fa-paper-plane"></i> Submit exam';

        if (exam.status === 'ended' && !state.studentSubmitted) {
            el('studentSaveHint').innerHTML = '<i class="fas fa-lock"></i> The invigilator ended this exam.';
        } else if (state.studentSubmitted) {
            el('studentSaveHint').innerHTML = '<i class="fas fa-check"></i> Answers submitted.';
        }
    }

    function renderStudentComplete() {
        el('studentExamPaper').classList.add('hidden');
        el('studentExamComplete').classList.remove('hidden');
        const submission = state.studentExam && state.studentExam.mySubmission;
        const when = submission && submission.submittedAt ? ` at ${formatTime(submission.submittedAt)}` : '';
        el('studentCompleteText').textContent = `Your answers were sent to the invigilator${when}. You can close this tab or keep watching the session.`;
        clearInterval(state.studentTimer);
    }

    function startStudentTimer() {
        clearInterval(state.studentTimer);
        const exam = state.studentExam;
        if (!exam || exam.status !== 'live' || state.studentSubmitted) {
            if (exam) {
                el('studentExamTimer').textContent = exam.status === 'ended' ? 'Ended' : '--:--';
                el('studentExamTimer').classList.remove('is-urgent');
            }
            return;
        }

        const tick = () => {
            const remaining = exam.endsAt - Date.now();
            const timerEl = el('studentExamTimer');
            timerEl.textContent = formatDuration(remaining);
            timerEl.classList.toggle('is-urgent', remaining <= 5 * 60 * 1000);

            if (remaining <= 0 && !state.autoSubmitted && !state.studentSubmitted) {
                state.autoSubmitted = true;
                toast('⏰ Time is up — submitting your answers', 'info');
                submitStudentExam(true);
            }
        };
        tick();
        state.studentTimer = setInterval(tick, 1000);
    }

    function sendSignal(message) {
        const app = window.proctoringApp;
        if (!app || !app.signaling || app.signaling.readyState !== WebSocket.OPEN) {
            return false;
        }
        app.signaling.send(JSON.stringify(message));
        return true;
    }

    function readAnswer(questionId) {
        const block = el('studentExamQuestions').querySelector(`[data-question-id="${questionId}"]`);
        if (!block) return undefined;
        const question = state.studentExam.questions.find(item => item.id === questionId);
        if (!question) return undefined;

        if (question.type === 'short') {
            const textarea = block.querySelector('textarea');
            return textarea ? textarea.value : '';
        }
        const checked = [...block.querySelectorAll('input:checked')].map(input => Number(input.value));
        if (question.type === 'multiple') return checked.sort((a, b) => a - b);
        return checked.length ? checked[0] : null;
    }

    function queueAnswer(questionId, immediate = false) {
        const value = readAnswer(questionId);
        if (value === undefined) return;
        state.localAnswers[questionId] = value;

        const block = el('studentExamQuestions').querySelector(`[data-question-id="${questionId}"]`);
        if (block) {
            block.querySelectorAll('.paper-option').forEach(label => {
                label.classList.toggle('checked', !!label.querySelector('input:checked'));
            });
        }

        clearTimeout(state.saveTimers.get(questionId));
        const delay = immediate ? 0 : 500;
        state.saveTimers.set(questionId, setTimeout(() => {
            const sent = sendSignal({ type: 'exam-answer', questionId, answer: value });
            if (sent) {
                el('studentSaveHint').innerHTML = '<i class="fas fa-cloud-arrow-up"></i> Saved just now';
            } else {
                el('studentSaveHint').innerHTML = '<i class="fas fa-triangle-exclamation"></i> Reconnecting — answer kept in this tab';
            }
        }, delay));
    }

    function submitStudentExam(auto = false) {
        if (!state.studentExam || state.studentSubmitted) return;
        if (!auto && !window.confirm('Submit your exam now? You cannot change your answers after submitting.')) return;

        state.studentExam.questions.forEach(question => queueAnswer(question.id, true));
        state.saveTimers.forEach(timer => clearTimeout(timer));
        state.saveTimers.clear();

        const sent = sendSignal({ type: 'exam-submit' });
        if (!sent) {
            toast('❌ Not connected to the invigilator. Your answers are kept here — try again once reconnected.', 'error');
            return;
        }

        state.studentSubmitted = true;
        const submitBtn = el('studentSubmitBtn');
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting…';
        el('studentSaveHint').innerHTML = '<i class="fas fa-paper-plane"></i> Sending your answers…';
    }

    function handleExamReceipt(data) {
        if (state.pageRole !== 'student') return;
        state.studentSubmitted = true;
        if (state.studentExam) {
            state.studentExam.mySubmission = state.studentExam.mySubmission || {
                submittedAt: data.submission ? data.submission.submittedAt : Date.now(),
                autoPossible: data.submission ? data.submission.autoPossible : null,
                needsReview: data.submission ? data.submission.needsReview : null
            };
        }
        renderStudentExam();
        if (state.studentSubmitted) renderStudentComplete();
        toast('✅ Exam submitted', 'success');
    }

    // ==================== SIGNALING ====================

    function handleSignalingMessage(data) {
        switch (data.type) {
            case 'exam-started':
                if (state.pageRole === 'student') {
                    setExamFromServer(data.exam);
                    switchWorkspace('exams');
                    toast(`📝 ${data.exam.title} has started`, 'info');
                } else {
                    setExamFromServer(data.exam);
                }
                break;

            case 'exam-ended':
                if (state.pageRole === 'student') {
                    setExamFromServer(data.exam);
                    toast('The invigilator ended the exam', 'info');
                } else {
                    setExamFromServer(data.exam);
                }
                break;

            case 'exam-progress':
                if (state.pageRole === 'proctor') {
                    state.deliveredExam = data.exam;
                    updateExamChip();
                    updateDeliveryUI();
                }
                break;

            case 'exam-submitted':
                if (state.pageRole === 'proctor') {
                    toast(`📥 ${data.userName} submitted the exam`, 'info');
                }
                break;

            case 'exam-receipt':
                handleExamReceipt(data);
                break;

            default:
                break;
        }
    }

    // ==================== WORKSPACE ====================

    function switchWorkspace(key) {
        if (state.pageRole === 'proctor') {
            if (key === 'bank' && !canAny(['questions', 'quizzes'])) return;
            if (key === 'subjects' && !can('subjects')) return;
            if (key === 'exams' && !canAny(['quizzes', 'invigilation'])) return;
            if (key === 'team' && !can('users')) return;
            if (key === 'students' && !can('students')) return;
        }
        document.querySelectorAll('.workspace-tab').forEach(tab => {
            const active = tab.dataset.workspace === key;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        document.querySelectorAll('[data-workspace-panel]').forEach(panel => {
            panel.classList.toggle('hidden', panel.dataset.workspacePanel !== key);
        });

        if (state.pageRole === 'proctor') {
            if (key === 'bank') {
                ensureBankLoaded();
                renderBank();
            } else if (key === 'exams') {
                ensureBankLoaded();
                loadExams().then(() => {
                    if (state.draft) {
                        renderQuestionPicker();
                        updateDeliveryUI();
                    }
                });
            }
        }
    }

    function setSession(session) {
        if (!session) return;
        const previousRoom = state.session.roomId;
        state.session.roomId = session.roomId || null;
        state.session.userType = session.userType || null;

        if (state.pageRole === 'proctor') {
            if (session.roomId !== previousRoom) {
                state.deliveredExam = null;
            }
            updateDeliveryUI();
            updateExamChip();
        }

        if (session.roomId && session.roomId !== state.lastRoomId) {
            state.lastRoomId = session.roomId;
            restoreRoomExam(session.roomId);
        }
    }

    // ==================== INIT ====================

    function bindEvents() {
        document.querySelectorAll('.workspace-tab').forEach(tab => {
            tab.addEventListener('click', () => switchWorkspace(tab.dataset.workspace));
        });
        el('examLiveChip')?.addEventListener('click', () => switchWorkspace('exams'));

        // The question editor reads its subject options from the bank payload
        document.addEventListener('verot:subjects-changed', () => {
            if (canAny(['questions', 'quizzes'])) loadBank();
        });

        el('newQuestionBtn')?.addEventListener('click', () => openQuestionEditor());
        el('bankSearch')?.addEventListener('input', renderBank);
        el('bankSubjectFilter')?.addEventListener('change', renderBank);
        el('bankTypeFilter')?.addEventListener('change', renderBank);

        el('bankList')?.addEventListener('click', event => {
            const button = event.target.closest('[data-action]');
            if (!button) return;
            const id = button.dataset.id;
            if (button.dataset.action === 'edit-question') {
                const question = state.questions.find(item => item.id === id);
                if (question) openQuestionEditor(question);
            } else if (button.dataset.action === 'delete-question') {
                deleteQuestion(id);
            }
        });

        el('questionForm')?.addEventListener('submit', saveQuestion);
        el('cancelQuestionBtn')?.addEventListener('click', closeQuestionEditor);
        el('questionSubject')?.addEventListener('change', event => {
            state.questionSubjectId = event.target.value;
        });
        el('addMultipleChoiceBtn')?.addEventListener('click', () => addDraft('multiple'));
        el('addEssayBtn')?.addEventListener('click', () => addDraft('short'));
        el('addTrueFalseBtn')?.addEventListener('click', () => addDraft('truefalse'));

        el('questionDrafts')?.addEventListener('input', event => {
            const field = event.target.closest('[data-draft-index]');
            if (!field) return;
            if (!event.target.matches('[data-field="prompt"], [data-field="marks"], [data-option]')) return;
            syncDraftFromCard(Number(field.dataset.draftIndex));
        });

        el('questionDrafts')?.addEventListener('change', event => {
            const card = event.target.closest('[data-draft-index]');
            if (!card) return;
            const index = Number(card.dataset.draftIndex);

            syncDraftFromCard(index);
            if (event.target.matches('[data-field="marks"]')) {
                setDraftMarks(index, event.target.value);
            }
        });

        el('questionDrafts')?.addEventListener('click', event => {
            const button = event.target.closest('[data-action]');
            if (!button) return;
            const card = button.closest('[data-draft-index]');
            if (!card) return;
            const index = Number(card.dataset.draftIndex);

            if (button.dataset.action === 'remove-draft') {
                removeDraft(index);
            } else if (button.dataset.action === 'marks-up' || button.dataset.action === 'marks-down') {
                syncAllDrafts();
                const draft = state.questionDrafts[index];
                if (!draft) return;
                setDraftMarks(index, draft.marks + (button.dataset.action === 'marks-up' ? 1 : -1));
            } else if (button.dataset.action === 'add-option') {
                addDraftOption(index);
            } else if (button.dataset.action === 'remove-option') {
                const row = button.closest('[data-option-index]');
                if (row) removeDraftOption(index, Number(row.dataset.optionIndex));
            }
        });

        el('newExamBtn')?.addEventListener('click', openExamModal);
        el('examForm')?.addEventListener('submit', createExam);
        el('cancelExamBtn')?.addEventListener('click', closeExamModal);
        el('examList')?.addEventListener('click', event => {
            const item = event.target.closest('[data-exam-id]');
            if (item) selectExam(item.dataset.examId);
        });
        el('examQuestionSearch')?.addEventListener('input', renderQuestionPicker);
        el('examQuestionPicker')?.addEventListener('change', event => {
            const checkbox = event.target.closest('[data-pick-question]');
            if (checkbox) {
                setQuestionPicked(checkbox.dataset.pickQuestion, checkbox.checked);
                return;
            }
            const marksInput = event.target.closest('[data-pick-marks]');
            if (marksInput) setQuestionMarks(marksInput.dataset.pickMarks, marksInput.value);
        });
        el('saveExamBtn')?.addEventListener('click', saveExam);
        el('deleteExamBtn')?.addEventListener('click', deleteExam);
        el('deliverExamBtn')?.addEventListener('click', deliverExam);
        el('endExamBtn')?.addEventListener('click', endExam);
        el('resultRows')?.addEventListener('click', event => {
            const button = event.target.closest('[data-review-index]');
            if (!button) return;
            const detail = el('resultRows').querySelector(`[data-detail-index="${button.dataset.reviewIndex}"]`);
            if (!detail) return;
            detail.classList.toggle('hidden');
            button.textContent = detail.classList.contains('hidden') ? 'View' : 'Hide';
        });

        el('studentExamQuestions')?.addEventListener('change', event => {
            const block = event.target.closest('[data-question-id]');
            if (block) queueAnswer(block.dataset.questionId);
        });
        el('studentExamQuestions')?.addEventListener('input', event => {
            if (event.target.tagName !== 'TEXTAREA') return;
            const block = event.target.closest('[data-question-id]');
            if (block) queueAnswer(block.dataset.questionId);
        });
        el('studentExamForm')?.addEventListener('submit', event => {
            event.preventDefault();
            submitStudentExam(false);
        });

        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            if (!el('questionModal').classList.contains('hidden')) {
                closeQuestionEditor();
            } else if (!el('examModal').classList.contains('hidden')) {
                closeExamModal();
            }
        });
    }

    async function init() {
        if (!el('workspaceBank')) return;
        bindEvents();

        if (state.pageRole === 'proctor') {
            await (window.verotAuth ? window.verotAuth.ready : Promise.resolve(null));
            if (canAny(['questions', 'quizzes'])) loadBank();
            if (canAny(['quizzes', 'invigilation'])) loadExams();
            const preferred = window.verotAuth && window.verotAuth.preferredWorkspace;
            if (preferred) switchWorkspace(preferred);
        }
    }

    window.examWorkspace = {
        setSession,
        setExamFromServer,
        handleSignalingMessage,
        switchWorkspace
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
