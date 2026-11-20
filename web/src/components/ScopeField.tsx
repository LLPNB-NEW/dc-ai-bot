import { SCOPE_IDS, SCOPE_LABELS, type Scope } from '../api';

export interface ScopeFieldProps {
  scope: Scope;
  scopeId: string;
  onScopeChange: (scope: Scope) => void;
  onScopeIdChange: (scopeId: string) => void;
}

export default function ScopeField(props: ScopeFieldProps) {
  return (
    <div className="row">
      <label className="field">
        <span>作用域</span>
        <select value={props.scope} onChange={(event) => props.onScopeChange(event.target.value as Scope)}>
          {SCOPE_IDS.map((scope) => (
            <option key={scope} value={scope}>
              {SCOPE_LABELS[scope]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>scopeId（guild/channel 的 Discord ID）</span>
        <input
          type="text"
          value={props.scopeId}
          disabled={props.scope === 'global'}
          placeholder={props.scope === 'global' ? 'global 固定为空串' : '例如 123456789012345678'}
          onChange={(event) => props.onScopeIdChange(event.target.value)}
        />
      </label>
    </div>
  );
}
