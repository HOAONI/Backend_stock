import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class LoginRequestDto {
  @IsString()
  @MinLength(1)
  username!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

export class ChangePasswordRequestDto {
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(1)
  newPassword!: string;

  @IsString()
  @MinLength(1)
  newPasswordConfirm!: string;
}

export class RegisterRequestDto {
  @IsString()
  @MinLength(3)
  username!: string;

  @IsString()
  @MinLength(1)
  password!: string;

  @IsString()
  @MinLength(1)
  confirmPassword!: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsString()
  @IsIn(['user', 'admin'])
  accountType?: 'user' | 'admin';

  @IsOptional()
  @IsString()
  adminSecret?: string;
}
