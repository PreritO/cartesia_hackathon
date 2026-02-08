import { useState } from 'react';

interface Props {
  annotatedFrame: string | null;
}

export function DetectionDebug({ annotatedFrame }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ padding: '0 16px', marginBottom: 8 }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          background: 'none',
          border: '1px solid #334155',
          borderRadius: 4,
          color: '#94a3b8',
          fontSize: 11,
          padding: '4px 8px',
          cursor: 'pointer',
          width: '100%',
          textAlign: 'left',
        }}
      >
        {expanded ? 'Hide' : 'Show'} Detection View
      </button>
      {expanded && (
        <div style={{ marginTop: 6, borderRadius: 6, overflow: 'hidden', background: '#1e293b' }}>
          {annotatedFrame ? (
            <img
              src={`data:image/jpeg;base64,${annotatedFrame}`}
              alt="Detection debug"
              style={{ width: '100%', display: 'block' }}
            />
          ) : (
            <div style={{ padding: 16, textAlign: 'center', color: '#64748b', fontSize: 12 }}>
              No detection frame yet. Commentary will include annotated frames.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
