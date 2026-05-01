'use client';
import { Copy, Check } from 'lucide-react';
import { useState } from 'react';

export default function JsonViewer({ data, label }: { data: Record<string, unknown>; label?: string }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(data, null, 2);

  const isEmpty = !data || Object.keys(data).length === 0;

  const copy = async () => {
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (isEmpty) {
    return (
      <div className="text-xs text-surface-500 italic">— empty —</div>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={copy}
        className="absolute top-2 right-2 btn-ghost text-xs px-2 py-1"
        title="Copy JSON"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className="bg-surface-900 text-surface-50 rounded-lg p-4 text-xs overflow-x-auto font-mono leading-relaxed max-h-80">
{json}
      </pre>
    </div>
  );
}
