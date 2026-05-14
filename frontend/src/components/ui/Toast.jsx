import React from 'react';
import { useAppStore } from '../../store/useAppStore';

export default function Toast() {
  const { toast } = useAppStore();

  if (!toast) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9999] animate-fade-in-up">
      <div className={`px-6 py-3 rounded-lg shadow-lg text-white font-bold flex items-center gap-2 ${toast.type === 'error' ? 'bg-red-600' : 'bg-gray-800'}`}>
        <span>{toast.message}</span>
      </div>
    </div>
  );
}
