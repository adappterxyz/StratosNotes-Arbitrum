import { AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { Issue } from '@sn/core';
import { Head } from './Head';

export function ValidatePanel({
  issues,
  onSelect,
}: {
  issues: { errors: Issue[]; warnings: Issue[] };
  onSelect: (id: string) => void;
}) {
  const ok = !issues.errors.length && !issues.warnings.length;
  return (
    <>
      <Head title="Validate" sub="The validator and the engine's compiler check every change as you make it." />
      <div className="section">
        {ok && (
          <div className="notice ok row">
            <CheckCircle2 className="i" />
            The engine accepts this workflow.
          </div>
        )}
        <ul className="issues">
          {issues.errors.map((e, i) => (
            <li
              key={`e${i}`}
              className={`err ${e.nodeId ? 'click' : ''}`}
              onClick={() => e.nodeId && onSelect(e.nodeId)}
            >
              <AlertCircle className="i" style={{ verticalAlign: -2, marginRight: 6 }} />
              {e.message}
            </li>
          ))}
          {issues.warnings.map((w, i) => (
            <li
              key={`w${i}`}
              className={`warn ${w.nodeId ? 'click' : ''}`}
              onClick={() => w.nodeId && onSelect(w.nodeId)}
            >
              <AlertTriangle className="i" style={{ verticalAlign: -2, marginRight: 6 }} />
              {w.message}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
