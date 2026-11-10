import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { OverlayTrigger, Popover } from "react-bootstrap";
import { TbHelp } from "react-icons/tb";

// CodeMirror paints placeholder highlights on the same single document it edits, so the
// caret can't drift on wrapped lines (the old textarea-over-<pre> trick did).

const PLACEHOLDER_DECORATION = Decoration.mark({
  attributes: { style: "background:rgba(25,135,84,0.3);border-radius:2px" },
});
const WHITESPACE_DECORATION = Decoration.mark({
  attributes: { style: "background:rgba(255,193,7,0.45);border-radius:2px" },
});

// One regex for named placeholders and the legacy DUMMY alias, like resolveTemplate.
const placeholderMatcher = new MatchDecorator({
  regexp: /\{\w+\}|DUMMY/g,
  decoration: () => PLACEHOLDER_DECORATION,
});

const placeholderHighlighter = ViewPlugin.fromClass(
  class {
    placeholders: DecorationSet;
    constructor(view: EditorView) {
      this.placeholders = placeholderMatcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.placeholders = placeholderMatcher.updateDeco(update, this.placeholders);
    }
  },
  { decorations: (v) => v.placeholders },
);

/** Leading/trailing whitespace in amber: it's trimmed on blur. */
function computeWhitespaceDecorations(view: EditorView): DecorationSet {
  const text = view.state.doc.toString();
  const builder = new RangeSetBuilder<Decoration>();
  const leading = /^\s+/.exec(text);
  const leadingEnd = leading ? leading[0].length : 0;
  if (leading) builder.add(0, leadingEnd, WHITESPACE_DECORATION);
  const trailing = /\s+$/.exec(text);
  if (trailing) {
    const trailingStart = text.length - trailing[0].length;
    if (trailingStart >= leadingEnd) builder.add(trailingStart, text.length, WHITESPACE_DECORATION);
  }
  return builder.finish();
}

const whitespaceHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = computeWhitespaceDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = computeWhitespaceDecorations(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const templateEditorTheme = EditorView.theme({
  "&": { fontFamily: "monospace", fontSize: "inherit" },
  ".cm-content": { padding: "10px" },
  ".cm-scroller": { overflow: "auto" },
});

export function TemplateEditor({
  value,
  onChange,
  minHeight = "6.5rem",
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  minHeight?: string;
  placeholder?: string;
}) {
  return (
    <CodeMirror
      value={value}
      onChange={(v) => onChange(v.replace(/[\r\n]/g, ""))}
      onBlur={() => onChange(value.trim())}
      extensions={[EditorView.lineWrapping, placeholderHighlighter, whitespaceHighlighter, templateEditorTheme]}
      theme="none"
      placeholder={placeholder}
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        autocompletion: false,
      }}
      className="form-control p-0"
      minHeight={minHeight}
    />
  );
}

const PLACEHOLDER_HELP = (
  <Popover id="placeholders-help" style={{ maxWidth: "26rem" }}>
    <Popover.Header as="h3">Плейсхолдеры в шаблоне</Popover.Header>
    <Popover.Body className="small">
      <p className="mb-2">
        Шаблон — это готовая ссылка, в которой креды пользователя подставляются на место плейсхолдеров. Каждому
        юзеру уходит своя копия.
      </p>
      <ul className="ps-3 mb-2">
        <li>
          <code>{"{uuid}"}</code> — идентификатор пользователя (VLESS). Легаси-алиас: <code>DUMMY</code>.
        </li>
        <li>
          <code>{"{user}"}</code> — логин (NaïveProxy, mieru). Совпадает с именем клиента.
        </li>
        <li>
          <code>{"{pass}"}</code> — пароль (NaïveProxy). Генерируется при первой выдаче подписки и дальше не
          меняется.
        </li>
        <li>
          <code>{"{sskey}"}</code> — личный ключ (Shadowsocks-2022). Генерируется так же.
        </li>
        <li>
          <code>{"{mpass}"}</code> — пароль mieru, отдельный от <code>{"{pass}"}</code>.
        </li>
        <li>
          <code>{"{ip}"}</code> — адрес из URL агента выбранного хоста. При переезде хоста достаточно поменять
          URL агента. Без хоста не работает.
        </li>
      </ul>
      <p className="mb-1 fw-semibold">Примеры</p>
      <div className="admin-code-wrap mb-1">
        <code>vless://{"{uuid}"}@{"{ip}"}:443?security=reality&amp;sni=microsoft.com#node-1</code>
      </div>
      <div className="admin-code-wrap mb-1">
        <code>naive+https://{"{user}"}:{"{pass}"}@api.example.com:443#node-2</code>
      </div>
      <div className="admin-code-wrap mb-1">
        <code>ss://2022-blake3-aes-128-gcm:IPSK:{"{sskey}"}@{"{ip}"}:9444#node-3</code>
      </div>
      <div className="admin-code-wrap">
        <code>
          mierus://{"{user}"}:{"{mpass}"}@{"{ip}"}?profile=🇩🇪 Node 4&amp;port=8444-8453&amp;protocol=TCP#🇩🇪 Node 4
        </code>
      </div>
      <p className="mb-0 mt-2 text-body-secondary">
        Текст после <code>#</code> — подпись, которую видят клиенты; профиль может её переопределить. mieru-клиенты
        показывают имя из <code>profile=</code>, а не из <code>#</code>.
      </p>
    </Popover.Body>
  </Popover>
);

export function PlaceholderHelp() {
  return (
    <OverlayTrigger trigger="click" rootClose placement="auto" overlay={PLACEHOLDER_HELP}>
      <button
        type="button"
        className="btn btn-link p-0 border-0 align-baseline text-body-tertiary ms-1"
        aria-label="Справка по плейсхолдерам"
      >
        <TbHelp size={15} />
      </button>
    </OverlayTrigger>
  );
}
