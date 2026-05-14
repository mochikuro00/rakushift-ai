import React, { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import API from '../../lib/api';

export default function ConfigPanel() {
  const { config, setConfig, showToast } = useAppStore();
  const [formData, setFormData] = useState({
    opening_time: config?.opening_time || '09:00',
    closing_time: config?.closing_time || '18:00',
    min_staff_per_shift: config?.min_staff_per_shift || 2,
    max_staff_per_shift: config?.max_staff_per_shift || 5
  });

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!config?.id) return;
    try {
      await API.update('config_safe', config.id, formData);
      setConfig(formData); // Note: Should probably update store properly with the whole config object
      showToast('設定を保存しました');
    } catch (err) {
      console.error(err);
      showToast('保存に失敗しました', 'error');
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 animate-fade-in max-w-2xl mx-auto">
      <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2 mb-6">
        <i className="fa-solid fa-gear text-purple-600"></i>
        店舗設定
      </h2>
      <form onSubmit={handleSave} className="space-y-6">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">営業開始</label>
            <input type="time" name="opening_time" value={formData.opening_time} onChange={handleChange} className="w-full border-gray-300 rounded-lg p-2 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-purple-500 transition-all outline-none" />
          </div>
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">営業終了</label>
            <input type="time" name="closing_time" value={formData.closing_time} onChange={handleChange} className="w-full border-gray-300 rounded-lg p-2 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-purple-500 transition-all outline-none" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">最小スタッフ数/枠</label>
            <input type="number" name="min_staff_per_shift" value={formData.min_staff_per_shift} onChange={handleChange} className="w-full border-gray-300 rounded-lg p-2 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-purple-500 transition-all outline-none" />
          </div>
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">最大スタッフ数/枠</label>
            <input type="number" name="max_staff_per_shift" value={formData.max_staff_per_shift} onChange={handleChange} className="w-full border-gray-300 rounded-lg p-2 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-purple-500 transition-all outline-none" />
          </div>
        </div>
        <div className="pt-4 border-t border-gray-100">
          <button type="submit" className="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 px-4 rounded-xl shadow-md transition-colors">
            設定を保存する
          </button>
        </div>
      </form>
    </div>
  );
}
