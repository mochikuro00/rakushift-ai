import React, { useState, useEffect } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Modal } from '../ui';
import API from '../../lib/api';
import { format } from 'date-fns';

export default function ShiftModal() {
  const { isShiftModalOpen, closeShiftModal, currentEditShift, currentEditDate, currentEditStaffId, staff, config, loadData, showToast, setLoading } = useAppStore();
  const [formData, setFormData] = useState({
    start_time: '09:00',
    end_time: '18:00',
    break_minutes: 60
  });

  useEffect(() => {
    if (isShiftModalOpen) {
      if (currentEditShift) {
        setFormData({
          start_time: currentEditShift.start_time,
          end_time: currentEditShift.end_time,
          break_minutes: currentEditShift.break_minutes
        });
      } else {
        setFormData({
          start_time: config?.opening_time || '09:00',
          end_time: config?.closing_time || '18:00',
          break_minutes: 60
        });
      }
    }
  }, [isShiftModalOpen, currentEditShift, config]);

  const handleChange = (e) => setFormData({ ...formData, [e.target.name]: e.target.value });

  const handleSave = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (currentEditShift) {
        await API.update('shifts', currentEditShift.id, formData);
        showToast('シフトを更新しました');
      } else {
        await API.create('shifts', {
          staff_id: currentEditStaffId,
          date: format(currentEditDate, 'yyyy-MM-dd'),
          ...formData
        });
        showToast('シフトを作成しました');
      }
      await loadData();
      closeShiftModal();
    } catch (err) {
      console.error(err);
      showToast('エラーが発生しました', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!currentEditShift || !confirm('このシフトを削除しますか？')) return;
    setLoading(true);
    try {
      await API.delete('shifts', currentEditShift.id);
      showToast('シフトを削除しました');
      await loadData();
      closeShiftModal();
    } catch (err) {
      console.error(err);
      showToast('削除に失敗しました', 'error');
    } finally {
      setLoading(false);
    }
  };

  const staffName = staff.find(s => s.id === currentEditStaffId)?.name || '不明';
  const dateStr = currentEditDate ? format(currentEditDate, 'yyyy-MM-dd') : '';

  return (
    <Modal 
      isOpen={isShiftModalOpen} 
      onClose={closeShiftModal} 
      title={currentEditShift ? 'シフト編集' : 'シフト追加'}
    >
      <div className="mb-4 text-sm font-bold text-gray-600">
        対象: {staffName} ({dateStr})
      </div>
      <form onSubmit={handleSave} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">開始時間</label>
            <input type="time" name="start_time" value={formData.start_time} onChange={handleChange} className="w-full border-gray-300 rounded-lg p-2 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-blue-500 transition-all outline-none" required />
          </div>
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">終了時間</label>
            <input type="time" name="end_time" value={formData.end_time} onChange={handleChange} className="w-full border-gray-300 rounded-lg p-2 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-blue-500 transition-all outline-none" required />
          </div>
        </div>
        <div>
          <label className="block text-sm font-bold text-gray-700 mb-1">休憩時間 (分)</label>
          <input type="number" name="break_minutes" value={formData.break_minutes} onChange={handleChange} className="w-full border-gray-300 rounded-lg p-2 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-blue-500 transition-all outline-none" min="0" step="15" />
        </div>
        
        <div className="flex justify-between pt-4 mt-4 border-t border-gray-100">
          {currentEditShift ? (
            <button type="button" onClick={handleDelete} className="text-red-500 hover:text-red-700 font-bold px-4 py-2 text-sm transition-colors">削除</button>
          ) : (
            <div></div>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={closeShiftModal} className="text-gray-500 hover:bg-gray-100 px-4 py-2 rounded-lg font-bold transition-colors text-sm">キャンセル</button>
            <button type="submit" className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-bold transition-colors shadow-sm text-sm">保存</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
