# ParkSezgi AWS Deployment Script
param(
    [switch]$Frontend,  # Önyüz dosyalarını S3'e yükle ve CloudFront önbelleğini temizle (Varsayılan)
    [switch]$Backend,   # Lambda fonksiyon kodunu güncelle
    [switch]$All,       # Hem önyüzü hem Lambda fonksiyonunu güncelle
    [switch]$Init,      # Terraform init
    [switch]$Plan,      # Terraform plan
    [switch]$Apply,     # Terraform apply (Altyapı değişiklikleri)
    [switch]$Destroy    # Terraform destroy (DİKKAT: Altyapıyı siler)
)

$ErrorActionPreference = "Stop"
$InfraDir = Join-Path $PSScriptRoot "infra"
$FrontendFiles = @("index.html", "app.js", "style.css", "scoring.js", "commercial_pois_db.json", "offline_pilot_streets.json")

# AWS CLI komutunu bul (PATH'te yoksa varsayılan kurulum dizinini dene)
$awsExe = if (Get-Command aws -ErrorAction SilentlyContinue) { "aws" } elseif (Test-Path "C:\Program Files\Amazon\AWSCLIV2\aws.exe") { "C:\Program Files\Amazon\AWSCLIV2\aws.exe" } else { "aws" }

# Eğer hiçbir switch verilmediyse varsayılan olarak Frontend dağıtımı yap
if (-not ($Frontend -or $Backend -or $All -or $Init -or $Plan -or $Apply -or $Destroy)) {
    $Frontend = $true
}

# 1. TERRAFORM İŞLEMLERİ
if ($Init) {
    Write-Host "📦 Terraform başlatılıyor..." -ForegroundColor Cyan
    Push-Location $InfraDir
    terraform init
    Pop-Location
    return
}

if ($Plan) {
    Write-Host "🔍 Terraform planı çıkarılıyor..." -ForegroundColor Cyan
    Push-Location $InfraDir
    terraform plan
    Pop-Location
    return
}

if ($Apply) {
    Write-Host "🏗️ Terraform altyapısı uygulanıyor..." -ForegroundColor Cyan
    Push-Location $InfraDir
    terraform apply -auto-approve
    Pop-Location
    Write-Host "✅ Altyapı güncellendi." -ForegroundColor Green
    return
}

if ($Destroy) {
    Write-Host "⚠️ DİKKAT: Altyapı siliniyor..." -ForegroundColor Red
    Push-Location $InfraDir
    terraform destroy
    Pop-Location
    return
}

# 2. BACKEND (LAMBDA) DAĞITIMI
if ($Backend -or $All) {
    Write-Host "`n⚡ Lambda fonksiyonu güncelleniyor (Backend Deploy)..." -ForegroundColor Cyan
    $lambdaDir = Join-Path $InfraDir "lambda\ratings"
    $zipPath = Join-Path $InfraDir "lambda\ratings.zip"

    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Compress-Archive -Path "$lambdaDir\index.mjs" -DestinationPath $zipPath -Force
    
    & $awsExe lambda update-function-code `
        --function-name parksezgi-ratings-api `
        --zip-file "fileb://$zipPath" | Out-Null

    Write-Host "✅ Lambda fonksiyonu güncellendi (parksezgi-ratings-api)." -ForegroundColor Green
}

# 3. FRONTEND (S3 + CLOUDFRONT) DAĞITIMI
if ($Frontend -or $All) {
    Write-Host "`n🌐 Önyüz dosyaları S3'e yükleniyor (Frontend Deploy)..." -ForegroundColor Cyan

    Push-Location $InfraDir
    $outputsJson = terraform output -json
    Pop-Location
    $outputs = $outputsJson | ConvertFrom-Json

    $staticBucket = $outputs.static_bucket.value
    $ratingsBucket = $outputs.ratings_bucket.value
    $cfDistId = $outputs.cloudfront_distribution_id.value

    # Statik dosyaları S3'e yükle
    foreach ($file in $FrontendFiles) {
        $filePath = Join-Path $PSScriptRoot $file
        if (Test-Path $filePath) {
            $contentType = switch ([IO.Path]::GetExtension($file)) {
                '.html' { 'text/html; charset=utf-8' }
                '.js'   { 'application/javascript; charset=utf-8' }
                '.css'  { 'text/css; charset=utf-8' }
                '.json' { 'application/json; charset=utf-8' }
                default { 'application/octet-stream' }
            }
            Write-Host "  -> Yükleniyor: $file ($contentType)" -ForegroundColor Gray
            & $awsExe s3 cp $filePath "s3://$staticBucket/$file" --content-type $contentType --quiet
        }
    }

    # ratings_aggregate.json sadece S3'te HENÜZ YOKSA başlangıç olarak yüklenir (Canlı kullanıcı oylarını ezmez)
    $remoteAggregate = & $awsExe s3 ls "s3://$ratingsBucket/ratings_aggregate.json" 2>$null
    if (-not $remoteAggregate) {
        Write-Host "  -> Başlangıç ratings_aggregate.json yükleniyor..." -ForegroundColor Yellow
        & $awsExe s3 cp (Join-Path $PSScriptRoot "ratings_aggregate.json") "s3://$ratingsBucket/ratings_aggregate.json" --content-type "application/json" --quiet
    } else {
        Write-Host "  -> Canlı ratings_aggregate.json korundu (üzerine yazılmadı)." -ForegroundColor Green
    }

    # CloudFront önbelleğini temizle (Invalidate cache)
    Write-Host "🔄 CloudFront CDN önbelleği temizleniyor..." -ForegroundColor Cyan
    $invalidation = & $awsExe cloudfront create-invalidation --distribution-id $cfDistId --paths "/*" | ConvertFrom-Json
    Write-Host "✅ Önbellek temizleme başlatıldı (ID: $($invalidation.Invalidation.Id))." -ForegroundColor Green

    Write-Host "`n🚀 Dağıtım başarıyla tamamlandı!" -ForegroundColor Green
    Write-Host "👉 Canlı Site: https://$($outputs.cloudfront_url.value)" -ForegroundColor White
}
