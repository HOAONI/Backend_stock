import { Module } from '@nestjs/common';

import { ImageStockExtractorService } from '@/common/image/image-stock-extractor.service';

import { StocksController } from './stocks.controller';
import { StocksService } from './stocks.service';

@Module({
  controllers: [StocksController],
  providers: [StocksService, ImageStockExtractorService],
  exports: [StocksService],
})
export class StocksModule {}
