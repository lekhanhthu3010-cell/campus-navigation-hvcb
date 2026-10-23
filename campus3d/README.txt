HVCB 3D + GPS — BẢN THỬ NGHIỆM
1. Chạy notebook Google Colab từ trên xuống.
2. Giải nén hvcb_3d_chiduong_gps.zip và upload TOÀN BỘ nội dung bên trong lên GitHub Pages (index.html, main.js, style.css, data/).
3. Trên điện thoại mở HTTPS từ GitHub Pages, tìm Tòa C và bật GPS. Nếu tô sáng sai, mở "Gán tên khối nhà" rồi chọn đúng khối.
4. Chưa có API key thì nền OpenFreeMap/MapLibre 3D vẫn dùng được, nút Google Maps mở chỉ đường ngoài ứng dụng.
5. Muốn bản đồ Google Maps NGAY TRÊN trang: tạo Maps JavaScript API key + Vector Map ID; giới hạn key theo HTTP referrer GitHub Pages và Maps JS API trước khi điền vào notebook. Có thể phát sinh chi phí theo mức sử dụng.
6. Tuyến từ dự án cũ là tuyến đã số hóa, chưa kiểm chứng trên thực địa. Tọa độ cuối tuyến là điểm tiếp cận, không nhất thiết là tâm tòa nhà.
7. Mô hình 3D là khối LoD1 từ OpenStreetMap, chiều cao thiếu dữ liệu là giả định. Phải kiểm tra lại các khối gán tự động.
