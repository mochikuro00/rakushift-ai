import React from 'react';
import { useAppStore } from '../../store/useAppStore';

export default function ShiftTable() {
  const { shifts, staff } = useAppStore();

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 animate-fade-in">
      <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2 mb-6">
        <i className="fa-solid fa-calendar-days text-blue-600"></i>
        シフト表 ({shifts.length}件のシフト)
      </h2>
      <div className="p-8 text-center border-2 border-dashed border-gray-200 rounded-xl bg-gray-50">
        <div className="text-gray-500 mb-4">
          <i className="fa-solid fa-person-digging text-4xl text-gray-300"></i>
        </div>
        <h3 className="text-lg font-bold text-gray-700 mb-2">シフト表は現在移行作業中です</h3>
        <p className="text-sm text-gray-600 max-w-lg mx-auto">
          ドラッグ＆ドロップによる複雑なシフト調整機能や、AIによるシフト自動生成（オートフィル）機能は、旧画面と互換性を保ちながら順次React版へ移植しています。（フェーズ3.5）
        </p>
      </div>
    </div>
  );
}
