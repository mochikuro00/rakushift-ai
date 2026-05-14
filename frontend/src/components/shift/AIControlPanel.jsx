import React, { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import API from '../../lib/api';
import { format, endOfWeek, addDays } from 'date-fns';
import { Wand2, AlertCircle, FileSearch, HelpCircle } from 'lucide-react';

export default function AIControlPanel() {
  const { weekStartDate, showToast, loadData, setLoading } = useAppStore();
  const [aiStatus, setAiStatus] = useState(null); // null, 'loading', 'success', 'error'
  const [diagnoseResult, setDiagnoseResult] = useState(null);

  const startStr = format(weekStartDate, 'yyyy-MM-dd');
  const endStr = format(endOfWeek(weekStartDate, { weekStartsOn: 1 }), 'yyyy-MM-dd');

  const handleAutoFill = async () => {
    if (!confirm(`${startStr} から ${endStr} までの1週間のシフトをAIで自動生成しますか？\n（すでに手動で入力されたシフトは上書きされません）`)) return;
    
    setLoading(true);
    setAiStatus('loading');
    setDiagnoseResult(null);
    try {
      const payload = {
        staff_list: useAppStore.getState().staff,
        config: useAppStore.getState().config,
        dates: Array.from({ length: 7 }, (_, i) => format(addDays(weekStartDate, i), 'yyyy-MM-dd')),
        requests: useAppStore.getState().requests,
        mode: 'auto'
      };
      const res = await API.generateShifts(payload);
      if (res && res.status === 'success') {
        if (res.shifts && res.shifts.length > 0) {
          // AIが生成したシフトをDBに一括保存
          const shiftsToSave = res.shifts.map(s => ({
            ...s,
            organization_id: useAppStore.getState().organizationId
          }));
          await API.upsert('shifts', shiftsToSave);
        }
        showToast('AIによるシフト生成が完了しました！');
        setAiStatus('success');
        await loadData();
      } else {
        throw new Error(res.error || '不明なエラー');
      }
    } catch (e) {
      console.error(e);
      showToast('AI生成に失敗しました: ' + (e.message || 'サーバーエラー'), 'error');
      setAiStatus('error');
    } finally {
      setLoading(false);
    }
  };

  const handleDiagnose = async () => {
    setLoading(true);
    setAiStatus('loading');
    setDiagnoseResult(null);
    try {
      const payload = {
        staff_list: useAppStore.getState().staff,
        config: useAppStore.getState().config,
        dates: Array.from({ length: 7 }, (_, i) => format(addDays(weekStartDate, i), 'yyyy-MM-dd')),
        requests: useAppStore.getState().requests
      };
      const res = await API.diagnose(payload);
      if (res && res.length >= 0) {
        setDiagnoseResult(res.join('\n'));
        setAiStatus('success');
      } else {
        throw new Error(res.error || '不明なエラー');
      }
    } catch (e) {
      console.error(e);
      showToast('AI診断に失敗しました', 'error');
      setAiStatus('error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-6 shadow-sm animate-fade-in-down mb-6">
      <div className="flex items-center gap-3 mb-4">
        <Wand2 className="w-6 h-6 text-indigo-600" />
        <h3 className="text-lg font-bold text-indigo-900">AI シフトアシスタント</h3>
        <span className="text-sm font-bold text-indigo-600 bg-indigo-100 px-3 py-1 rounded-full">
          対象期間: {startStr} 〜 {endStr}
        </span>
      </div>

      <div className="flex flex-wrap gap-4 mb-4">
        <button 
          onClick={handleAutoFill}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl font-bold shadow-md transition-all flex items-center gap-2"
        >
          <Wand2 className="w-5 h-5" /> シフトを自動作成する
        </button>
        <button 
          onClick={handleDiagnose}
          className="bg-white border-2 border-indigo-200 text-indigo-700 hover:bg-indigo-100 px-6 py-3 rounded-xl font-bold shadow-sm transition-all flex items-center gap-2"
        >
          <FileSearch className="w-5 h-5" /> AIシフト診断（問題点の洗い出し）
        </button>
        <a 
          href="/docs/AI_TIPS.html" 
          target="_blank"
          className="bg-gray-100 text-gray-600 hover:bg-gray-200 px-4 py-3 rounded-xl font-bold transition-all flex items-center gap-2 ml-auto text-sm"
        >
          <HelpCircle className="w-4 h-4" /> AI活用のコツ
        </a>
      </div>

      {diagnoseResult && (
        <div className="mt-6 bg-white p-6 rounded-xl border border-indigo-100 shadow-sm">
          <h4 className="font-bold text-gray-800 flex items-center gap-2 mb-4 border-b border-gray-100 pb-3">
            <AlertCircle className="w-5 h-5 text-orange-500" />
            AI診断レポート
          </h4>
          <div className="prose prose-sm max-w-none prose-indigo">
            <div dangerouslySetInnerHTML={{ __html: diagnoseResult.replace(/\n/g, '<br/>') }} />
          </div>
        </div>
      )}
    </div>
  );
}
