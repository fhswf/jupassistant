import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { INotebookTracker } from '@jupyterlab/notebook';
import { IStatusBar } from '@jupyterlab/statusbar';
import { checkIcon, codeCheckIcon } from '@jupyterlab/ui-components';
import { Message } from '@lumino/messaging';
import { ISignal, Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { showDialog, Dialog } from '@jupyterlab/apputils';

// Importe der wichtigen JSON-Dateien, Modularität
import modelsData from './models.json';
import codePromptsData from './code-prompts.json';
import textPromptsData from './text-prompts.json';

const CommandIds = {
  renderMarkdownCell: 'toolbar-button:render-markdown-cell',
  runCodeCell: 'toolbar-button:run-code-cell'
};

// Universeller Prompt mit wichtigen Informationen zum allgemeinen Verhalten des LLMs
const UNIVERSAL_PROMPT = "Du bist ein Experte in der Verbesserung von Code und Texten und musst alle Eingaben streng anhand der folgenden Vorgaben bearbeiten: Deine Antwort erfolgt ausschließlich als reines JSON-Objekt ohne jegliche zusätzlichen Zeichen, Erklärungen oder Formatierungen, und zwar exakt nach folgendem Schema: {\"explanation\": \"<Markdown-formatierte Erklärung>\", \"code\": \"<Reiner Code oder Text ohne Kommentare>\"}. Standardmäßig antwortest du in Englisch, passt deine Sprache jedoch automatisch an, wenn der zu prüfende Text oder Code überwiegend in einer anderen Sprache verfasst ist oder wenn auch nur ein wenig deutscher Text enthalten ist; in diesem Fall antworte ausschließlich auf Deutsch. Stelle zudem sicher, dass die gesamte Antwort in einer einzigen Sprache erfolgt und keine Sprachmischungen enthält. Verändere unter keinen Umständen die grundlegenden Inhalte, sondern verbessere den Code oder Text lediglich anhand der vorgegebenen Qualitätskriterien, sodass alle Originalinformationen erhalten bleiben. Achte bei der Überprüfung und Rückgabe von Texten zudem auf die korrekte Markdown-Formatierung und sorge dafür, dass die Erklärung in der Markdown-Zelle einheitlich formatiert ist, beispielsweise beginnend mit einer klaren Überschrift wie \"## Explanation\" gefolgt von einem strukturierten Fließtext. Nach diesem universellen Prompt werden zunächst die Qualitätskriterien-Prompts angehängt, welche sämtliche spezifische Anforderungen an die Verbesserung enthalten, und im Anschluss folgt der Notebook-Kontext, der den Kontext des gesamten Notebooks beinhaltet und dir dabei hilft, den aktiven Zellinhalt besser bewerten zu können. Bitte halte dich strikt an diese Vorgaben und gib ausschließlich das reine JSON-Objekt gemäß dem genannten Schema zurück.";

// Sammelt den Inhalt aller Zellen eines bestimmten Typs aus dem aktiven Notebook und kürzt den Kontext, wenn er zu lang ist.
function getNotebookContext(tracker: INotebookTracker, cellType: string): string {
  const notebookPanel = tracker.currentWidget;
  if (!notebookPanel) {
    return "";
  }
  let context = "";
  notebookPanel.content.widgets.forEach(cell => {
    if (cell.model.type === cellType) {
      context += cell.model.sharedModel.getSource() + "\n\n";
    }
  });
  const maxLength = 32000; // Maximale Zeichenanzahl
  if (context.length > maxLength) {
    context = context.substring(0, maxLength) + "\n[Context truncated]";
  }
  return context;
}

// Widget, dass den API-Key Eingabebereich bzw. das Einstellungsmenü darstellt
class ApiKeyWidget extends Widget {
  private _modelDropdown: HTMLSelectElement;
  private _inputField: HTMLInputElement;
  private _saveButton: HTMLButtonElement;
  private _checkboxes: HTMLInputElement[] = []; // Code-Prompts
  private _languageCheckboxes: HTMLInputElement[] = []; // Text-Prompts
  private _messageChanged = new Signal<ApiKeyWidget, string>(this);
  private _storedApiKey: string = '';
  private _boundOnSaveButtonClick: (ev: Event) => void;
  private _models: any[] = [];

  constructor() {
    super();

    // Style-Block für das Widget
    const style = document.createElement('style');
    style.textContent = `
      .jp-apikey-widget {
        padding: 10px;
        font-family: var(--jp-ui-font-family);
        background: var(--jp-layout-color1);
        border: 1px solid var(--jp-border-color2);
        border-radius: 4px;
        margin: 10px;
      }
      .jp-apikey-heading {
        font-size: 1.2em;
        font-weight: bold;
        margin: 0 0 5px 0;
      }
      .jp-llm-model-container,
      .jp-apikey-container,
      .jp-checklist-container {
        margin-bottom: 10px;
      }
      .jp-apikey-input {
        width: 100%;
        padding: 4px;
        border: 1px solid var(--jp-border-color2);
        border-radius: 4px;
        box-sizing: border-box;
      }
      .jp-apikey-save-button {
        margin-top: 10px;
        padding: 4px 8px;
        background-color: var(--jp-brand-color1);
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
      }
      .jp-apikey-save-button:hover {
        background-color: var(--jp-brand-color2);
      }
      .jp-checklist-item {
        margin: 4px 0;
      }
      .jp-checklist-item label {
        margin-left: 4px;
      }
      .header-container {
        display: flex;
        align-items: center;
      }
    `;
    this.node.appendChild(style);
    this.addClass('jp-apikey-widget');

    // Dropdown für LLM-Modell
    const modelContainer = document.createElement('div');
    modelContainer.classList.add('jp-llm-model-container');
    const modelHeading = document.createElement('h3');
    modelHeading.classList.add('jp-apikey-heading');
    modelHeading.innerText = 'LLM Model';
    modelContainer.appendChild(modelHeading);

    const modelDropdown = document.createElement('select');
    modelDropdown.classList.add('jp-llm-model-dropdown');
    modelContainer.appendChild(modelDropdown);
    this.node.appendChild(modelContainer);
    this._modelDropdown = modelDropdown;

    // Modelle aus models.json laden
    if (modelsData && modelsData.models) {
      this._models = modelsData.models;
      this._models.forEach((model: any, index: number) => {
        const option = document.createElement('option');
        option.value = index.toString();
        option.text = model.name;
        modelDropdown.appendChild(option);
      });
    } else {
      console.error('Models JSON konnte nicht geladen werden.');
    }

    // API-Key Label und Eingabefeld
    const apiKeyContainer = document.createElement('div');
    apiKeyContainer.classList.add('jp-apikey-container');
    const apiKeyHeading = document.createElement('h3');
    apiKeyHeading.classList.add('jp-apikey-heading');
    apiKeyHeading.innerText = 'API-Key';
    apiKeyContainer.appendChild(apiKeyHeading);

    const inputField = document.createElement('input');
    inputField.type = 'text';
    inputField.placeholder = 'Enter API Key here...';
    inputField.classList.add('jp-apikey-input');
    apiKeyContainer.appendChild(inputField);
    this.node.appendChild(apiKeyContainer);
    this._inputField = inputField;

    // Erste Checkliste (Code-Qualität) aus code-prompts.json
    const checklistContainer = document.createElement('div');
    checklistContainer.classList.add('jp-checklist-container');

    // Kleine "Alle auswählen"-Checkbox und Überschrift in einer Zeile
    const codeHeaderContainer = document.createElement('div');
    codeHeaderContainer.classList.add('header-container');
    const selectAllCodeCheckbox = document.createElement('input');
    selectAllCodeCheckbox.type = 'checkbox';
    selectAllCodeCheckbox.id = 'select-all-code';
    selectAllCodeCheckbox.style.marginRight = '4px';
    const codeHeaderLabel = document.createElement('span');
    codeHeaderLabel.classList.add('jp-apikey-heading');
    codeHeaderLabel.innerText = 'Code Quality';
    codeHeaderContainer.appendChild(selectAllCodeCheckbox);
    codeHeaderContainer.appendChild(codeHeaderLabel);
    checklistContainer.appendChild(codeHeaderContainer);

    const codeKeys = Object.keys(codePromptsData);
    codeKeys.forEach(key => {
      const checkboxWrapper = document.createElement('div');
      checkboxWrapper.classList.add('jp-checklist-item');

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = key;
      checkbox.id = `checkbox-${key.replace(/\s/g, '-')}`;

      const checkboxLabel = document.createElement('label');
      checkboxLabel.htmlFor = checkbox.id;
      checkboxLabel.innerText = key;

      checkboxWrapper.appendChild(checkbox);
      checkboxWrapper.appendChild(checkboxLabel);
      checklistContainer.appendChild(checkboxWrapper);

      // Beim Ändern einer Einzel-Checkbox prüfen, ob alle ausgewählt sind
      checkbox.addEventListener('change', () => {
        const allChecked = this._checkboxes.every(cb => cb.checked);
        selectAllCodeCheckbox.checked = allChecked;
      });

      this._checkboxes.push(checkbox);
    });
    this.node.appendChild(checklistContainer);

    // Event-Listener für "Alle auswählen" in Code-Quality
    selectAllCodeCheckbox.addEventListener('change', () => {
      this._checkboxes.forEach(checkbox => {
        checkbox.checked = selectAllCodeCheckbox.checked;
      });
    });

    // Zweite Checkliste (Text-Qualität) aus text-prompts.json
    const languageChecklistContainer = document.createElement('div');
    languageChecklistContainer.classList.add('jp-checklist-container');

    // Kleine "Alle auswählen"-Checkbox und Überschrift in einer Zeile
    const textHeaderContainer = document.createElement('div');
    textHeaderContainer.classList.add('header-container');
    const selectAllTextCheckbox = document.createElement('input');
    selectAllTextCheckbox.type = 'checkbox';
    selectAllTextCheckbox.id = 'select-all-text';
    selectAllTextCheckbox.style.marginRight = '4px';
    const textHeaderLabel = document.createElement('span');
    textHeaderLabel.classList.add('jp-apikey-heading');
    textHeaderLabel.innerText = 'Text Quality';
    textHeaderContainer.appendChild(selectAllTextCheckbox);
    textHeaderContainer.appendChild(textHeaderLabel);
    languageChecklistContainer.appendChild(textHeaderContainer);

    const textKeys = Object.keys(textPromptsData);
    textKeys.forEach(key => {
      const checkboxWrapper = document.createElement('div');
      checkboxWrapper.classList.add('jp-checklist-item');

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = key;
      checkbox.id = `checkbox-lang-${key.replace(/\s/g, '-')}`;

      const checkboxLabel = document.createElement('label');
      checkboxLabel.htmlFor = checkbox.id;
      checkboxLabel.innerText = key;

      checkboxWrapper.appendChild(checkbox);
      checkboxWrapper.appendChild(checkboxLabel);
      languageChecklistContainer.appendChild(checkboxWrapper);

      // Beim Ändern einer Einzel-Checkbox prüfen, ob alle ausgewählt sind
      checkbox.addEventListener('change', () => {
        const allChecked = this._languageCheckboxes.every(cb => cb.checked);
        selectAllTextCheckbox.checked = allChecked;
      });

      this._languageCheckboxes.push(checkbox);
    });
    this.node.appendChild(languageChecklistContainer);

    // Event-Listener für "Alle auswählen" in Text-Quality
    selectAllTextCheckbox.addEventListener('change', () => {
      this._languageCheckboxes.forEach(checkbox => {
        checkbox.checked = selectAllTextCheckbox.checked;
      });
    });

    // Button zur Speicherung
    const saveButton = document.createElement('button');
    saveButton.innerText = 'Save settings';
    saveButton.classList.add('jp-apikey-save-button');
    this.node.appendChild(saveButton);
    this._saveButton = saveButton;

    this._boundOnSaveButtonClick = this._onSaveButtonClick.bind(this);
  }

  get messageChanged(): ISignal<ApiKeyWidget, string> {
    return this._messageChanged;
  }

  public getApiKey(): string {
    return this._storedApiKey;
  }

  public getSelectedModel(): any {
    const index = this._modelDropdown.selectedIndex;
    return this._models[index];
  }

  public getSelectedCodePrompts(): string[] {
    return this._checkboxes
      .filter(checkbox => checkbox.checked)
      .map(checkbox => checkbox.value);
  }

  public getSelectedTextPrompts(): string[] {
    return this._languageCheckboxes
      .filter(checkbox => checkbox.checked)
      .map(checkbox => checkbox.value);
  }

  protected onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    this._inputField.addEventListener('input', this._onInputChange.bind(this));
    this._saveButton.addEventListener('click', this._boundOnSaveButtonClick);
  }

  protected onBeforeDetach(msg: Message): void {
    this._inputField.removeEventListener('input', this._onInputChange.bind(this));
    this._saveButton.removeEventListener('click', this._boundOnSaveButtonClick);
    super.onBeforeDetach(msg);
  }

  private _onInputChange(): void {
    const value = this._inputField.value;
    this._messageChanged.emit(value);
  }

  private _onSaveButtonClick(ev: Event): void {
    this._storedApiKey = this._inputField.value;
  }
}

// Haupt-Plugin
const plugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlab-examples/cell-toolbar:plugin',
  description:
    'A JupyterLab extension to add cell toolbar buttons with an LLM integration for checking and correcting code and text.',
  autoStart: true,
  requires: [INotebookTracker],
  optional: [IStatusBar],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker, statusBar: IStatusBar | null) => {
    const { commands, shell } = app;
    const apiKeyWidget = new ApiKeyWidget();
    apiKeyWidget.id = 'JupyterApiKeyWidget';
    shell.add(apiKeyWidget, 'right');

    // Variablen zur Steuerung des Cooldowns (30 Sekunden)
    let codeLastExecution = 0;
    let markdownLastExecution = 0;

    // Command für Code-Zellen (LLM-Check für Code)
    commands.addCommand(CommandIds.runCodeCell, {
      icon: codeCheckIcon,
      caption: 'Check code via LLM',
      execute: async () => {
        // Cooldown-Überprüfung für Code-Zellen
        const now = Date.now();
        if (now < codeLastExecution + 30000) {
          const remaining = Math.ceil((codeLastExecution + 30000 - now) / 1000);
          await showDialog({
            title: 'Error | Cooldown active',
            body: `Please wait ${remaining} seconds, before pressing this button again.`,
            buttons: [Dialog.okButton()]
          });
          return;
        }
        codeLastExecution = now;

        const activeCell = tracker.activeCell;
        if (activeCell && activeCell.model.type === 'code') {
          const cellContent = activeCell.model.sharedModel.getSource();

          const apiKey = apiKeyWidget.getApiKey();
          if (!apiKey) {
            await showDialog({
              title: 'Error | API',
              body: 'No API Key has been entered!',
              buttons: [Dialog.okButton()]
            });
            return;
          }
          const selectedModel = apiKeyWidget.getSelectedModel();
          if (!selectedModel) {
            await showDialog({
              title: 'Error | LLM',
              body: 'No LLM model was selected!',
              buttons: [Dialog.okButton()]
            });
            return;
          }
          const selectedCodePrompts = apiKeyWidget.getSelectedCodePrompts();
          if (!selectedCodePrompts.length) {
            await showDialog({
              title: 'Error | Checklists',
              body: 'Please select at least one option from the Code Quality checklist!',
              buttons: [Dialog.okButton()]
            });
            return;
          }

          const notebookContext = getNotebookContext(tracker, 'code');
          const systemMessage = UNIVERSAL_PROMPT + " " +
            selectedCodePrompts.map(key => (codePromptsData as Record<string, string>)[key]).join(' ') +
            "\n\nNotebook Context:\n" + notebookContext;

          const requestBody = {
            model: selectedModel.modelParameter,
            messages: [
              { role: "system", content: systemMessage },
              { role: "user", content: cellContent }
            ]
          };

          try {
            const response = await fetch(selectedModel.endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
              },
              body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
              await showDialog({
                title: 'Error | API',
                body: 'Error with API. Please check whether the API Key is valid.\nError code: ' + response.statusText,
                buttons: [Dialog.okButton()]
              });
              return;
            }

            const data = await response.json();
            const answer = data.choices[0].message.content;
            let jsonResponse;
            try {
              jsonResponse = JSON.parse(answer);
            } catch (error) {
              await showDialog({
                title: 'Error | JSON Parsing',
                body: 'Die Antwort des LLM konnte nicht als JSON geparst werden.',
                buttons: [Dialog.okButton()]
              });
              return;
            }

            const notebookPanel = tracker.currentWidget;
            if (notebookPanel) {
              // Speichere den originalen aktiven Zellindex
              const originalIndex = notebookPanel.content.activeCellIndex;
              
              // Neue Markdown-Zelle (Erklärung) unterhalb der originalen Zelle einfügen
              await commands.execute('notebook:insert-cell-below');
              await new Promise(resolve => setTimeout(resolve, 50));
              notebookPanel.content.activeCellIndex = originalIndex + 1;
              await commands.execute('notebook:change-cell-to-markdown');
              notebookPanel.content.widgets[originalIndex + 1].model.sharedModel.setSource(jsonResponse.explanation);
              await commands.execute('notebook:run-cell');
              
              // Neue Code-Zelle (Code) unterhalb der Markdown-Zelle einfügen
              await commands.execute('notebook:insert-cell-below');
              await new Promise(resolve => setTimeout(resolve, 50));
              notebookPanel.content.activeCellIndex = originalIndex + 2;
              await commands.execute('notebook:change-cell-to-code');
              notebookPanel.content.widgets[originalIndex + 2].model.sharedModel.setSource(jsonResponse.code);
            }
          } catch (error: any) {
            await showDialog({
              title: 'Error | API',
              body: 'Error code: ' + error,
              buttons: [Dialog.okButton()]
            });
          }
        }
      },
      isVisible: () => tracker.activeCell?.model.type === 'code'
    });

    // Command für Markdown-Zellen (LLM-Check für Text)
    commands.addCommand(CommandIds.renderMarkdownCell, {
      icon: checkIcon,
      caption: 'Check text via LLM',
      execute: async () => {
        // Cooldown-Überprüfung für Markdown-Zellen
        const now = Date.now();
        if (now < markdownLastExecution + 30000) {
          const remaining = Math.ceil((markdownLastExecution + 30000 - now) / 1000);
          await showDialog({
            title: 'Error | Cooldown active',
            body: `Please wait ${remaining} seconds, before pressing this button again.`,
            buttons: [Dialog.okButton()]
          });
          return;
        }
        markdownLastExecution = now;

        const activeCell = tracker.activeCell;
        if (activeCell && activeCell.model.type === 'markdown') {
          const cellContent = activeCell.model.sharedModel.getSource();

          const apiKey = apiKeyWidget.getApiKey();
          if (!apiKey) {
            await showDialog({
              title: 'Error | API',
              body: 'No API Key has been entered!',
              buttons: [Dialog.okButton()]
            });
            return;
          }
          const selectedModel = apiKeyWidget.getSelectedModel();
          if (!selectedModel) {
            await showDialog({
              title: 'Error | LLM',
              body: 'No LLM model was selected!',
              buttons: [Dialog.okButton()]
            });
            return;
          }
          const selectedTextPrompts = apiKeyWidget.getSelectedTextPrompts();
          if (!selectedTextPrompts.length) {
            await showDialog({
              title: 'Error | Checklists',
              body: 'Please select at least one option from the Text Quality checklist!',
              buttons: [Dialog.okButton()]
            });
            return;
          }

          const notebookContext = getNotebookContext(tracker, 'markdown');
          const systemMessage = UNIVERSAL_PROMPT + " " +
            selectedTextPrompts.map(key => (textPromptsData as Record<string, string>)[key]).join(' ') +
            "\n\nNotebook Context:\n" + notebookContext;

          const requestBody = {
            model: selectedModel.modelParameter,
            messages: [
              { role: "system", content: systemMessage },
              { role: "user", content: cellContent }
            ]
          };

          try {
            const response = await fetch(selectedModel.endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
              },
              body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
              await showDialog({
                title: 'Error | API',
                body: 'Error with API. Please check whether the API Key is valid.\nError code: ' + response.statusText,
                buttons: [Dialog.okButton()]
              });
              return;
            }

            const data = await response.json();
            const answer = data.choices[0].message.content;
            let jsonResponse;
            try {
              jsonResponse = JSON.parse(answer);
            } catch (error) {
              await showDialog({
                title: 'Error | JSON Parsing',
                body: 'Die Antwort des LLM konnte nicht als JSON geparst werden.',
                buttons: [Dialog.okButton()]
              });
              return;
            }

            const notebookPanel = tracker.currentWidget;
            if (notebookPanel) {
              const originalIndex = notebookPanel.content.activeCellIndex;
              
              // Neue Markdown-Zelle (Erklärung) unterhalb der originalen Zelle einfügen
              await commands.execute('notebook:insert-cell-below');
              await new Promise(resolve => setTimeout(resolve, 50));
              notebookPanel.content.activeCellIndex = originalIndex + 1;
              await commands.execute('notebook:change-cell-to-markdown');
              notebookPanel.content.widgets[originalIndex + 1].model.sharedModel.setSource(jsonResponse.explanation);
              await commands.execute('notebook:run-cell');

              // Neue Markdown-Zelle (Text) unterhalb der Markdown-Zelle einfügen
              await commands.execute('notebook:insert-cell-below');
              await new Promise(resolve => setTimeout(resolve, 50));
              notebookPanel.content.activeCellIndex = originalIndex + 2;
              await commands.execute('notebook:change-cell-to-markdown');
              notebookPanel.content.widgets[originalIndex + 2].model.sharedModel.setSource(jsonResponse.code);
            }
          } catch (error: any) {
            await showDialog({
              title: 'Error | API',
              body: 'Error code: ' + error,
              buttons: [Dialog.okButton()]
            });
          }
        }
      },
      isVisible: () => tracker.activeCell?.model.type === 'markdown'
    });
  }
};

export default plugin;
